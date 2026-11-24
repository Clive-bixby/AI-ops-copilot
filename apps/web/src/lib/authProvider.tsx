import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, clearSession, decodeToken, errorMessage, getOrgId, getToken, storeSession } from './api';
import { AuthContext } from './auth';
import type { AuthContextValue } from './auth';
import type { Session } from './types';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [orgId, setOrgIdState] = useState<string | null>(() => getOrgId());
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // With no stored session there is nothing to restore, so the app is ready on
  // the first render. Deciding that here rather than in the effect below keeps
  // the mount path free of a synchronous state update.
  const [ready, setReady] = useState(() => !getToken() || !getOrgId());
  const mounted = useRef(true);

  // Written as a promise chain rather than `await` inside try/catch: a
  // synchronous throw would otherwise reach `catch` -- and its state updates --
  // during the mount effect, which is what `set-state-in-effect` rejects.
  const refreshSession = useCallback(() => {
    if (!getToken() || !getOrgId()) {
      return Promise.resolve();
    }

    return api.auth.me().then(
      (next) => {
        if (!mounted.current) return;
        setSession(next);
        setSessionError(null);
        setReady(true);
      },
      (error: unknown) => {
        if (!mounted.current) return;
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403) {
          clearSession();
          setTokenState(null);
          setOrgIdState(null);
          setSession(null);
        }
        setSessionError(errorMessage(error));
        setReady(true);
      }
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refreshSession();
    return () => {
      mounted.current = false;
    };
  }, [refreshSession]);

  useEffect(() => {
    const onUnauthorized = () => {
      clearSession();
      setTokenState(null);
      setOrgIdState(null);
      setSession(null);
      setSessionError(null);
    };
    window.addEventListener('opspilot:unauthorized', onUnauthorized);
    return () => window.removeEventListener('opspilot:unauthorized', onUnauthorized);
  }, []);

  const login = useCallback(
    async (email: string, password: string, register?: { organizationName: string }) => {
      const result = register
        ? await api.auth.register(email, password, register.organizationName)
        : await api.auth.login(email, password);

      if (!result.token) {
        throw new Error('The API did not return a session token.');
      }

      const decoded = decodeToken(result.token);
      if (!decoded?.organizationId) {
        throw new Error('This account is not attached to an organization.');
      }

      storeSession(result.token, decoded.organizationId);
      setTokenState(result.token);
      setOrgIdState(decoded.organizationId);
      setSession(null);
      setSessionError(null);
      setReady(true);

      try {
        const next = await api.auth.me();
        setSession(next);
      } catch {
        /* token is valid; session details can retry in the shell */
      }
    },
    []
  );

  const logout = useCallback(() => {
    clearSession();
    setTokenState(null);
    setOrgIdState(null);
    setSession(null);
    setSessionError(null);
  }, []);

  const role = useMemo(() => {
    if (session?.role) return session.role;
    if (token) return decodeToken(token)?.role ?? null;
    return null;
  }, [session, token]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      token,
      orgId,
      role,
      session,
      sessionError,
      login,
      logout,
      refreshSession,
      isAdmin: role === 'owner' || role === 'admin',
    }),
    [ready, token, orgId, role, session, sessionError, login, logout, refreshSession]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
