import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api, errorMessage, storeSession } from './api';

/**
 * `request()` is the only place status codes are interpreted, so these tests
 * pin the contract every page relies on: which statuses resolve, which throw,
 * what the thrown message says, and when the session is invalidated.
 */

type Call = { url: string; init?: RequestInit };

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    },
  } as unknown as Response;
}

function mockFetch(handler: (url: string) => Response): ReturnType<typeof vi.fn> {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input));
  });

  vi.stubGlobal('fetch', fn);
  (fn as unknown as { calls: Call[] }).calls = calls;

  return fn;
}

function lastHeaders(fetchMock: ReturnType<typeof vi.fn>): Headers {
  const call = (fetchMock as unknown as { calls: Call[] }).calls.at(-1);
  return new Headers(call?.init?.headers ?? {});
}

beforeEach(() => {
  localStorage.clear();
});

describe('request(): success paths', () => {
  it('resolves the parsed body and sends the stored identity', async () => {
    storeSession('token-1', 'org-1');
    const fetchMock = mockFetch(() => response(200, [{ id: 'doc-1' }]));

    const documents = await api.documents.list();

    expect(documents).toEqual([{ id: 'doc-1' }]);
    const call = (fetchMock as unknown as { calls: Call[] }).calls[0]!;
    expect(call.url).toBe('http://localhost:3000/documents');
    expect(lastHeaders(fetchMock).get('Authorization')).toBe('Bearer token-1');
    expect(lastHeaders(fetchMock).get('x-organization-id')).toBe('org-1');
    expect(lastHeaders(fetchMock).get('Content-Type')).toBe('application/json');
  });

  it('resolves undefined for 204 without reading a body', async () => {
    const json = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 204, json }) as unknown as Response)
    );

    await expect(
      api.investigations.unlinkEvidence('investigation-1', 'evidence-1')
    ).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });
});

describe('request(): error paths', () => {
  it('throws ApiError with the server body message', async () => {
    mockFetch(() => response(400, { error: 'Ingestion batch is too large' }));

    await expect(api.documents.list()).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      message: 'Ingestion batch is too large',
    });
  });

  it('falls back to `message`, then to the status line', async () => {
    mockFetch(() => response(409, { message: 'Already exists' }));
    await expect(api.documents.list()).rejects.toThrow('Already exists');

    mockFetch(() => response(500));
    await expect(api.documents.list()).rejects.toThrow('Request failed (500)');
  });

  it('fires opspilot:unauthorized on 401 and still throws', async () => {
    mockFetch(() => response(401, { error: 'Unauthorized' }));
    const onUnauthorized = vi.fn();
    window.addEventListener('opspilot:unauthorized', onUnauthorized);

    await expect(api.auth.me()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    window.removeEventListener('opspilot:unauthorized', onUnauthorized);
  });

  it('maps a network failure to status 0 with an actionable message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const error = await api.documents.list().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0 });
    expect(errorMessage(error)).toBe(
      'Cannot reach the OpsPilot API at http://localhost:3000. Is the server running?'
    );
  });

  it('maps an aborted request to a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      })
    );

    await expect(api.ai.health()).rejects.toMatchObject({
      status: 0,
      message: 'The API request timed out.',
    });
  });
});

describe('request(): acceptedStatuses', () => {
  it('reads a 503 as data only on the endpoint that accepted it', async () => {
    const payload = {
      healthy: false,
      provider: 'gemini',
      model: 'text-embedding-004',
      dimensions: 768,
      endpoint: 'https://example.test',
      message: 'model missing',
      generation: {
        provider: 'gemini',
        model: 'gemini-3.5-flash-lite',
        fallback: null,
        error: 'The configured generation model was shut down by Google.',
      },
    };

    mockFetch(() => response(503, payload));

    const health = await api.ai.health();
    expect(health.healthy).toBe(false);
    expect(health.generation?.error).toMatch(/shut down by Google/);

    // The same status is still an error for an ordinary read: nothing except
    // `/ai/health` opts in.
    await expect(api.documents.list()).rejects.toMatchObject({ status: 503 });
  });

  it('still throws for a non-2xx status that was not accepted', async () => {
    mockFetch(() => response(429, { error: 'Too many AI requests' }));

    await expect(api.ai.ask('why did checkout fail')).rejects.toMatchObject({
      status: 429,
      message: 'Too many AI requests',
    });
  });
});
