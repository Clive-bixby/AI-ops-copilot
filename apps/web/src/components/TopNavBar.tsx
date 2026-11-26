import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { useApiData } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { initials, titleCase } from '../lib/format';
import type { ApiHealth, SystemStatus } from '../lib/types';
import { Icon } from './ui';

interface ShellStatus {
  system: SystemStatus | null;
  health: ApiHealth | null;
  healthError: string | null;
}

export function TopNavBar({ onMenuClick }: { onMenuClick: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { session, role, isAdmin } = useAuth();
  const [command, setCommand] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const { data } = useApiData<ShellStatus>(async () => {
    const [system, health] = await Promise.all([
      api.status().catch(() => null),
      // Rejects only for an unreachable API: a 503 still carries the payload, so
      // a retired model arrives as `health.generation.error`, not as an error.
      api.ai.health().catch((error: unknown) => errorMessage(error)),
    ]);

    if (typeof health === 'string') {
      return { system, health: null, healthError: health };
    }

    return { system, health, healthError: health?.generation?.error ?? null };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = command.trim();
    if (!value) return;
    navigate(`/search?q=${encodeURIComponent(value)}`);
    setCommand('');
  };

  const orgName = session?.organization.name ?? 'Organization';
  const environment = data?.system?.environment ?? 'api';
  const healthy = data?.health?.healthy === true;
  const generation = data?.health?.generation;
  const roleLabel = titleCase(role ?? 'member');

  const embeddingsTitle = data?.health
    ? [
        `Embeddings: ${data.health.model}${data.health.healthy ? '' : ' (unavailable)'}`,
        data.health.endpoint,
      ]
        .filter(Boolean)
        .join(' · ')
    : data?.healthError ?? 'Embedding health check pending';

  const generationTitle = generation
    ? `Generation: ${generation.provider}/${generation.model}${generation.error ? ` — ${generation.error}` : ''}`
    : 'Generation: not reported by this API';

  const pageLabel =
    {
      '/': 'Command Center',
      '/copilot': 'AI Copilot',
      '/logs': 'Logs Explorer',
      '/tickets': 'Tickets & Incidents',
      '/documents': 'Knowledge & Docs',
      '/search': 'Semantic Search',
      '/admin': 'Admin & Roles',
      '/settings': 'Settings',
    }[location.pathname] ?? 'OpsPilot';

  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-3 border-b border-outline-variant bg-surface px-3 sm:px-4 lg:px-6">
      <button
        onClick={onMenuClick}
        className="rounded p-1.5 text-on-surface-variant transition-colors hover:bg-surface-low hover:text-on-surface md:hidden"
        aria-label="Open navigation"
      >
        <Icon name="menu" size={22} />
      </button>

      <div className="hidden min-w-0 items-center gap-2 lg:flex">
        <div className="flex h-7 w-7 items-center justify-center rounded border border-outline-variant bg-surface-low text-on-surface-variant">
          <Icon name="domain" size={15} />
        </div>
        <div className="min-w-0">
          <div className="max-w-[190px] truncate font-label-lg text-label-lg font-semibold text-on-surface">
            {orgName}
          </div>
          <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-outline">
            {environment} · {roleLabel}
          </div>
        </div>
        <span className="mx-1 hidden h-6 w-px bg-line xl:block" />
        <span className="hidden font-body text-body-sm text-on-surface-variant xl:inline">{pageLabel}</span>
      </div>

      <form onSubmit={submit} className="relative min-w-0 flex-1 lg:max-w-md">
        <Icon
          name="search"
          size={17}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-outline"
        />
        <input
          ref={inputRef}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="Quick command or search…"
          aria-label="Quick command or search"
          className="h-8 w-full rounded border border-outline-variant bg-surface-low pl-8 pr-14 font-body text-body-sm text-on-surface placeholder:text-outline focus:border-primary focus:bg-surface focus:outline-none"
        />
        <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-outline-variant bg-surface px-1.5 py-0.5 font-mono text-[9px] text-outline sm:block">
          ⌘K
        </kbd>
      </form>

      <div className="ml-auto flex items-center gap-2">
        <div
          className={clsx(
            'hidden items-center gap-1.5 rounded border px-2 py-1.5 font-mono text-label-sm sm:flex',
            healthy
              ? 'border-success-line bg-success-surface text-success-ink'
              : 'border-outline-variant bg-surface-low text-on-surface-variant'
          )}
          title={embeddingsTitle}
        >
          <span
            className={clsx(
              'h-1.5 w-1.5 rounded-full',
              healthy ? 'animate-pulse bg-success' : 'bg-outline'
            )}
          />
          <span className="hidden xl:inline">EMBEDDINGS:</span>
          <span className="font-semibold">{healthy ? 'LIVE' : 'OFFLINE'}</span>
        </div>

        {generation?.error ? (
          <div
            className="hidden items-center gap-1.5 rounded border border-warning-line bg-warning-surface px-2 py-1.5 font-mono text-label-sm text-warning-ink md:flex"
            title={generationTitle}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-warning" />
            <span className="hidden xl:inline">GENERATION:</span>
            <span className="font-semibold">OFFLINE</span>
          </div>
        ) : null}

        <div className="hidden items-center gap-1.5 rounded border border-outline-variant bg-surface-low px-2 py-1.5 font-mono text-label-sm text-on-surface-variant md:flex">
          <Icon name="deployed_code" size={13} className="text-outline" />
          <span className="uppercase tracking-wider">{environment}</span>
        </div>

        <button
          onClick={() => navigate('/copilot')}
          className="hidden items-center gap-1.5 rounded bg-primary px-3 py-2 font-label-lg text-label-lg font-semibold text-on-primary transition-colors hover:bg-primary-container sm:flex"
        >
          <Icon name="neurology" size={16} />
          Investigate
        </button>

        <div
          className="flex h-8 w-8 items-center justify-center rounded border border-outline-variant bg-surface-low font-mono text-[11px] font-bold text-on-surface-variant"
          title={`${session?.user.email ?? 'Signed in'} · ${roleLabel}${isAdmin ? ' · admin access' : ''}`}
        >
          {initials(session?.user.email)}
        </div>
      </div>
    </header>
  );
}
