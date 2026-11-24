import { createContext, useContext } from 'react';
import type { Session } from './types';

/**
 * The session context and its hook.
 *
 * `AuthProvider` lives in `authProvider.tsx` so that each module exports either
 * components or values, which is what fast refresh needs: editing the context
 * here reloads the consumers, editing the provider no longer remounts the app.
 */

export interface AuthContextValue {
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

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
