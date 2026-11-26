import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import App from './App';
import { storeSession } from './lib/api';

/**
 * Route protection lives in the shell: `App` renders the login screen instead of
 * the routed pages whenever there is no session. These tests render the real
 * app at a protected URL, because that is the property that matters -- a deep
 * link to `/investigations` must not render the page before the session is
 * restored, and an expired token must not leave a readable shell behind.
 */

const SESSION = {
  user: { id: 'user-1', email: 'engineer@example.test' },
  organization: { id: 'org-1', name: 'Acme' },
  role: 'member',
};

function encode(value: object): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function seedStoredSession(): void {
  const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    userId: 'user-1',
    organizationId: 'org-1',
    role: 'member',
  })}.signature`;

  storeSession(token, 'org-1');
}

function routeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    const route = routes[path];
    const status = route?.status ?? 404;

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route?.body ?? { error: 'not found' },
    } as unknown as Response;
  });

  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe('protected routes', () => {
  it('renders login instead of a deep-linked page when there is no session', () => {
    const fetchMock = routeFetch({});

    renderAt('/investigations');

    expect(screen.getByText('Sign in to the command center')).toBeInTheDocument();
    expect(screen.queryByLabelText('Quick command or search')).not.toBeInTheDocument();
    // Nothing to verify means nothing to ask the API for.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an expired session back to login and clears it', async () => {
    seedStoredSession();
    routeFetch({ '/auth/me': { status: 401, body: { error: 'Unauthorized' } } });

    renderAt('/investigations');

    expect(
      await screen.findByText('Sign in to the command center')
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Quick command or search')).not.toBeInTheDocument();
    expect(localStorage.getItem('jwt')).toBeNull();
    expect(localStorage.getItem('orgId')).toBeNull();
  });

  it('renders the protected shell after the session is restored', async () => {
    seedStoredSession();
    const fetchMock = routeFetch({
      '/auth/me': { status: 200, body: SESSION },
      '/investigations': {
        status: 200,
        body: { investigations: [], total: 0, limit: 200, offset: 0 },
      },
    });

    renderAt('/investigations');

    expect(await screen.findByLabelText('Quick command or search')).toBeInTheDocument();
    expect(screen.queryByText('Sign in to the command center')).not.toBeInTheDocument();

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input]) => new URL(String(input)).pathname === '/investigations'
        )
      ).toBe(true)
    );
  });
});
