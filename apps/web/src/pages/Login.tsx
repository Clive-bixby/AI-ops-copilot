import { useState } from 'react';
import { API_URL } from '../lib/api';

function decodeOrgId(token: string): string | null {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    return JSON.parse(jsonPayload).organizationId || null;
  } catch {
    return null;
  }
}

export function Login({ onAuth }: { onAuth: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    try {
      const url = isRegister ? '/auth/register' : '/auth/login';
      const body: any = { email, password };
      if (isRegister) body.organizationName = orgName || 'My Organization';
      const res = await fetch(`${API_URL}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const token = data.token;
      const orgId = decodeOrgId(token);
      if (!token || !orgId) throw new Error('Invalid auth response');
      localStorage.setItem('jwt', token);
      localStorage.setItem('orgId', orgId);
      onAuth();
    } catch (e: any) {
      setError(e.message || 'Auth failed');
    }
  };

  return (
    <div className="h-screen w-screen bg-background flex items-center justify-center">
      <div className="bg-surface-container-low border border-outline-variant/15 rounded-2xl p-8 w-full max-w-md space-y-4">
        <h1 className="text-2xl font-bold text-on-surface">{isRegister ? 'Register' : 'Login'}</h1>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="w-full bg-surface border border-outline-variant/20 rounded-xl px-4 py-2 text-on-surface" />
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" className="w-full bg-surface border border-outline-variant/20 rounded-xl px-4 py-2 text-on-surface" />
        {isRegister && (
          <input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Organization name" className="w-full bg-surface border border-outline-variant/20 rounded-xl px-4 py-2 text-on-surface" />
        )}
        {error && <div className="text-error text-sm">{error}</div>}
        <button onClick={submit} className="w-full bg-primary text-on-primary py-2 rounded-xl font-bold">
          {isRegister ? 'Create account' : 'Sign in'}
        </button>
        <button onClick={() => setIsRegister(!isRegister)} className="w-full text-on-surface-variant text-sm">
          {isRegister ? 'Have an account? Sign in' : 'Need an account? Register'}
        </button>
      </div>
    </div>
  );
}
