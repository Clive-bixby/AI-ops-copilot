import { useState } from 'react';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { Badge, Button, Icon, InlineError } from '../components/ui';

const features = [
  {
    icon: 'neurology',
    title: 'Grounded RAG answers',
    body: 'Every response is retrieved from your indexed knowledge and returned with citations and confidence.',
  },
  {
    icon: 'database',
    title: 'pgvector retrieval',
    body: 'Chunked documents are embedded and searched with cosine similarity inside your organization scope.',
  },
  {
    icon: 'shield_person',
    title: 'Tenant isolation',
    body: 'JWT sessions, membership roles and organization-scoped queries keep every workspace separate.',
  },
];

export function Login() {
  const { login } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(
        email.trim(),
        password,
        mode === 'register' ? { organizationName: organizationName.trim() } : undefined
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-background">
      <button
        onClick={toggleTheme}
        className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface text-on-surface-variant transition-colors hover:text-on-surface"
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        <Icon name={theme === 'dark' ? 'light_mode' : 'dark_mode'} size={18} />
      </button>

      <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
        <section className="relative hidden flex-col justify-between overflow-hidden border-r border-line bg-surface-low px-10 py-10 lg:flex xl:px-16">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.55]"
            style={{
              backgroundImage:
                'linear-gradient(rgb(var(--line-strong) / 0.35) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--line-strong) / 0.35) 1px, transparent 1px)',
              backgroundSize: '48px 48px',
              maskImage: 'radial-gradient(ellipse at 20% 10%, black 20%, transparent 75%)',
            }}
          />

          <div className="relative flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded bg-primary text-on-primary">
              <Icon name="troubleshoot" size={20} />
            </span>
            <span className="font-display text-[24px] font-bold tracking-tight text-on-surface">OpsPilot</span>
            <span className="rounded border border-outline-variant bg-surface px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-outline">
              AI Ops Copilot
            </span>
          </div>

          <div className="relative max-w-xl">
            <div className="mb-4 flex items-center gap-2 font-mono text-label-sm uppercase tracking-[0.16em] text-outline">
              <span className="h-1.5 w-1.5 rounded-full bg-secondary" />
              Autonomous runtime observability
            </div>
            <h1 className="font-display text-[clamp(40px,4.6vw,64px)] font-extrabold leading-[1.02] tracking-[-0.035em] text-on-surface">
              Operational clarity,
              <br />
              grounded in
              <span className="relative ml-3 inline-block text-primary">
                evidence
                <span className="absolute inset-x-0 -bottom-1 h-[3px] bg-primary/70" />
              </span>
              .
            </h1>
            <p className="mt-6 max-w-lg font-body text-body-lg text-on-surface-variant">
              One workspace for logs, tickets and runbooks. Ask the copilot a question and get an answer
              tied back to the exact chunks it was built from.
            </p>

            <div className="mt-10 divide-y divide-line border-y border-line">
              {features.map((feature) => (
                <div key={feature.title} className="flex items-start gap-4 py-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-outline-variant bg-surface text-primary">
                    <Icon name={feature.icon} size={18} />
                  </span>
                  <div>
                    <div className="font-label-lg text-label-lg font-semibold text-on-surface">{feature.title}</div>
                    <p className="mt-0.5 max-w-md font-body text-body-sm text-on-surface-variant">{feature.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="relative flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.12em] text-outline">
            <span>Express 5</span>
            <span className="h-1 w-1 rounded-full bg-outline" />
            <span>PostgreSQL + pgvector</span>
            <span className="h-1 w-1 rounded-full bg-outline" />
            <span>React 19</span>
          </div>
        </section>

        <section className="flex flex-col justify-center px-5 py-10 sm:px-10 lg:px-12">
          <div className="mx-auto w-full max-w-sm">
            <div className="mb-8 flex items-center gap-2.5 lg:hidden">
              <span className="flex h-9 w-9 items-center justify-center rounded bg-primary text-on-primary">
                <Icon name="troubleshoot" size={20} />
              </span>
              <span className="font-display text-[24px] font-bold tracking-tight text-on-surface">OpsPilot</span>
            </div>

            <div className="mb-2 flex items-center gap-2">
              <Badge tone="primary" icon="lock">Secure access</Badge>
              <span className="font-mono text-label-sm uppercase tracking-wider text-outline">
                JWT · Org scoped
              </span>
            </div>
            <h2 className="font-headline-lg text-headline-lg tracking-tight text-on-surface">
              {mode === 'login' ? 'Sign in to the command center' : 'Create your operations workspace'}
            </h2>
            <p className="mt-1 font-body text-body-md text-on-surface-variant">
              {mode === 'login'
                ? 'Use the account and organization you already own.'
                : 'Registering creates an organization and makes you its owner.'}
            </p>

            <form onSubmit={submit} className="mt-7 space-y-4">
              <label className="flex flex-col gap-1">
                <span className="mono-label text-on-surface-variant">Work email</span>
                <input
                  className="input"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="mono-label text-on-surface-variant">Password</span>
                <input
                  className="input"
                  type="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  minLength={6}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••"
                />
                {mode === 'register' ? (
                  <span className="font-body text-body-sm text-outline">At least 10 characters.</span>
                ) : null}
              </label>

              {mode === 'register' ? (
                <label className="flex flex-col gap-1">
                  <span className="mono-label text-on-surface-variant">Organization name</span>
                  <input
                    className="input"
                    type="text"
                    required
                    value={organizationName}
                    onChange={(event) => setOrganizationName(event.target.value)}
                    placeholder="Acme Engineering"
                  />
                </label>
              ) : null}

              {error ? <InlineError message={error} /> : null}

              <Button type="submit" size="lg" icon={loading ? 'sync' : 'login'} disabled={loading} className="w-full">
                {loading
                  ? mode === 'login'
                    ? 'Signing in…'
                    : 'Creating workspace…'
                  : mode === 'login'
                    ? 'Sign in'
                    : 'Create workspace'}
              </Button>
            </form>

            <div className="mt-5 flex items-center justify-between gap-2 border-t border-line pt-4">
              <span className="font-body text-body-sm text-on-surface-variant">
                {mode === 'login' ? 'No workspace yet?' : 'Already have an account?'}
              </span>
              <button
                type="button"
                onClick={() => {
                  setMode(mode === 'login' ? 'register' : 'login');
                  setError('');
                }}
                className="font-label-lg text-label-lg font-semibold text-primary hover:underline"
              >
                {mode === 'login' ? 'Create one' : 'Sign in'}
              </button>
            </div>

            <p className="mt-6 font-body text-body-sm leading-relaxed text-outline">
              Sessions use a bearer token stored in this browser. Every request is scoped to the
              organization embedded in that token.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
