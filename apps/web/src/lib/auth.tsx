import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api, clearSession, decodeToken, errorMessage, getOrgId, getToken, storeSession } from './api';
import type { Session } from './types';

interface AuthContextValue {
  ready: boolean;
  token: string | null;
  orgId: string | null;
  role: string | null;
  session: Session | null;
  sessionError: string | null;
  login: (email: string, password: string, register?: { organizationName: string }) => Promise<void>;
  logout: () => void;
  refreshSession: () => Promise<void>;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [orgId, setOrgIdState] = useState<string | null>(() => getOrgId());
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const mounted = useRef(true);

  const refreshSession = useCallback(async () => {
    if (!getToken() || !getOrgId()) {
      setReady(true);
      return;
    }

    try {
      const next = await api.auth.me();
      if (!mounted.current) return;
      setSession(next);
      setSessionError(null);
    } catch (error) {
      if (!mounted.current) return;
      const status = (error as { status?: number }).status;
      if (status === 401 || status === 403) {
        clearSession();
        setTokenState(null);
        setOrgIdState(null);
        setSession(null);
      }
      setSessionError(errorMessage(error));
    } finally {
      if (mounted.current) setReady(true);
    }
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

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
