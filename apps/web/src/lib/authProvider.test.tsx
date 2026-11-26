import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { storeSession } from './api';
import { useAuth } from './auth';
import { AuthProvider } from './authProvider';

/**
 * Session lifecycle at the provider boundary: a stored session is restored,
 * and both expiry signals (a 401/403 from `/auth/me`, and the
 * `opspilot:unauthorized` event any request dispatches) clear the credential
 * and the organization id together. A half-cleared session would leave the
 * shell showing a tenant it can no longer read.
 */

function encode(value: object): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function tokenWith(payload: Record<string, unknown>): string {
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

function Probe() {
  const { ready, token, orgId, session, sessionError } = useAuth();

  return (
    <div>
      <span data-testid="ready">{String(ready)}</span>
      <span data-testid="token">{token ?? 'none'}</span>
      <span data-testid="org">{orgId ?? 'none'}</span>
      <span data-testid="email">{session?.user.email ?? 'none'}</span>
      <span data-testid="role">{session?.role ?? 'none'}</span>
      <span data-testid="error">{sessionError ?? 'none'}</span>
    </div>
  );
}

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function mockFetch(status: number, body?: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => response(status, body)));
}

const SESSION = {
  user: { id: 'user-1', email: 'engineer@example.test' },
  organization: { id: 'org-1', name: 'Acme' },
  role: 'member',
};

function seedStoredSession(): string {
  const token = tokenWith({ userId: 'user-1', organizationId: 'org-1', role: 'member' });
  storeSession(token, 'org-1');

  return token;
}

describe('AuthProvider session restore', () => {
  it('restores a stored session from /auth/me', async () => {
    seedStoredSession();
    mockFetch(200, SESSION);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() =>
      expect(screen.getByTestId('email')).toHaveTextContent('engineer@example.test')
    );
    expect(screen.getByTestId('ready')).toHaveTextContent('true');
    expect(screen.getByTestId('org')).toHaveTextContent('org-1');
    expect(screen.getByTestId('token')).not.toHaveTextContent('none');
  });

  it('clears the session and storage when the stored token is rejected', async () => {
    seedStoredSession();
    mockFetch(401, { error: 'Unauthorized' });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));

    expect(screen.getByTestId('token')).toHaveTextContent('none');
    expect(screen.getByTestId('org')).toHaveTextContent('none');
    expect(screen.getByTestId('email')).toHaveTextContent('none');
    expect(localStorage.getItem('jwt')).toBeNull();
    expect(localStorage.getItem('orgId')).toBeNull();
  });

  it('clears a live session when a request reports 401', async () => {
    seedStoredSession();
    mockFetch(200, SESSION);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() =>
      expect(screen.getByTestId('email')).toHaveTextContent('engineer@example.test')
    );

    act(() => {
      window.dispatchEvent(new Event('opspilot:unauthorized'));
    });

    expect(screen.getByTestId('token')).toHaveTextContent('none');
    expect(screen.getByTestId('org')).toHaveTextContent('none');
    expect(screen.getByTestId('error')).toHaveTextContent('none');
    expect(localStorage.getItem('jwt')).toBeNull();
    expect(localStorage.getItem('orgId')).toBeNull();
  });

  it('does not call the API when there is no stored session', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
