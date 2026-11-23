import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { api, decodeToken, errorMessage, getToken } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { useApiData } from '../lib/hooks';
import { formatDateTime, shortId, titleCase } from '../lib/format';
import type { ApiHealth, SystemStatus } from '../lib/types';
import {
  Badge,
  Button,
  CopyButton,
  ErrorState,
  Icon,
  PageHeader,
  Panel,
} from '../components/ui';

interface SettingsData {
  status: SystemStatus | null;
  health: ApiHealth | null;
  healthError: string | null;
}

export function Settings() {
  const { session, role, logout, isAdmin } = useAuth();
  const { theme, setTheme } = useTheme();

  const { data, loading, error, reload } = useApiData<SettingsData>(async () => {
    const [status, health] = await Promise.all([
      api.status().catch(() => null),
      api.ai.health().catch((caught: unknown) => ({ error: errorMessage(caught) })),
    ]);

    if (health && 'error' in health) {
      return { status, health: null, healthError: String(health.error) };
    }

    return { status, health: health as ApiHealth | null, healthError: null };
  }, []);

  const token = getToken();
  const decoded = token ? decodeToken(token) : null;
  const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null;

  const permissions = isAdmin
    ? ['Read all operational data', 'Ingest logs and tickets', 'Upload and index documents', 'Semantic search and copilot', 'Organization member directory']
    : ['Read all operational data', 'Ingest logs and tickets', 'Upload and index documents', 'Semantic search and copilot'];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <>
            <span className="eyebrow">Workspace &amp; system configuration</span>
            <span className="h-1 w-1 rounded-full bg-outline" />
            <span className="font-mono text-label-sm uppercase tracking-wider text-primary">
              {session?.organization.name ?? 'Organization'}
            </span>
            <Badge tone="neutral">{data?.status?.environment ?? 'api'}</Badge>
          </>
        }
        title="Platform & Engine Settings"
        description="Session, workspace and retrieval-engine details available from this deployment. Server-side configuration is read-only unless the API exposes a mutation route."
        actions={
          <Button variant="secondary" icon="refresh" onClick={() => void reload()} disabled={loading}>
            Refresh health
          </Button>
        }
      />

      {error && !data ? (
        <ErrorState message={error} onRetry={() => void reload()} />
      ) : (
        <div className="grid items-start gap-gutter-desktop lg:grid-cols-12">
          <div className="flex min-w-0 flex-col gap-gutter lg:col-span-8">
            <Panel title="Workspace identity" icon="domain" meta="Read-only">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="mono-label text-outline">Workspace name</div>
                  <div className="mt-1 font-headline-sm text-headline-sm text-on-surface">
                    {session?.organization.name ?? '—'}
                  </div>
                  <p className="mt-1 font-body text-body-sm text-on-surface-variant">
                    Every query, ingestion and retrieval is scoped to this organization.
                  </p>
                </div>
                <div>
                  <div className="mono-label text-outline">Organization ID</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="break-all font-mono text-[11px] text-on-surface">
                      {session?.organization.id ?? '—'}
                    </span>
                    {session?.organization.id ? <CopyButton value={session.organization.id} label="" /> : null}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div>
                      <div className="mono-label text-outline">Your role</div>
                      <Badge tone={isAdmin ? 'ai' : 'neutral'} className="mt-1">
                        {titleCase(role ?? 'member')}
                      </Badge>
                    </div>
                    <div>
                      <div className="mono-label text-outline">Environment</div>
                      <div className="mt-1 font-mono text-[11px] uppercase text-on-surface">
                        {data?.status?.environment ?? 'unknown'}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <p className="mt-3 border-t border-line pt-2 font-body text-[11px] leading-relaxed text-outline">
                Renaming the workspace, retention policy and region selection are not exposed by the
                current API, so they are not editable here.
              </p>
            </Panel>

            <Panel title="Account & session" icon="badge">
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ['Signed in as', session?.user.email ?? '—'],
                  ['User ID', session?.user.id ? shortId(session.user.id, 12) : '—'],
                  ['Token expires', expiresAt ? formatDateTime(expiresAt) : '—'],
                  ['Auth model', 'JWT bearer + organization header'],
                ].map(([label, value]) => (
                  <div key={label}>
                    <div className="mono-label text-outline">{label}</div>
                    <div className="mt-1 break-words font-mono text-[11px] text-on-surface">{value}</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-2">
                <Button variant="danger" size="sm" icon="logout" onClick={logout}>
                  Sign out
                </Button>
                <Link
                  to="/admin"
                  className="inline-flex items-center gap-1.5 rounded border border-outline-variant bg-surface px-2.5 py-1 font-label-lg text-label-lg text-on-surface transition-colors hover:bg-surface-low"
                >
                  <Icon name="admin_panel_settings" size={15} /> {isAdmin ? 'Open admin' : 'Admin access'}
                </Link>
                <span className="font-body text-body-sm text-outline">
                  Signing out clears the token from this browser.
                </span>
              </div>
            </Panel>

            <Panel title="Appearance" icon="palette">
              <div className="grid gap-2 sm:grid-cols-2">
                {(['light', 'dark'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setTheme(mode)}
                    aria-pressed={theme === mode}
                    className={clsx(
                      'flex items-center justify-between gap-3 rounded border p-3 text-left transition-colors',
                      theme === mode
                        ? 'border-primary bg-primary-fixed/30'
                        : 'border-outline-variant bg-surface hover:bg-surface-low'
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-low text-on-surface-variant">
                        <Icon name={mode === 'light' ? 'light_mode' : 'dark_mode'} size={18} />
                      </span>
                      <div>
                        <div className="font-label-lg text-label-lg font-semibold text-on-surface">
                          {mode === 'light' ? 'Light Mode' : 'Dark Mode'}
                        </div>
                        <div className="font-body text-body-sm text-on-surface-variant">
                          {mode === 'light' ? 'Porcelain editorial canvas' : 'Low-light ops room'}
                        </div>
                      </div>
                    </div>
                    {theme === mode ? <Badge tone="primary">active</Badge> : null}
                  </button>
                ))}
              </div>
              <p className="mt-2 font-body text-[11px] text-outline">
                The preference is stored in this browser. Both themes use the same design tokens.
              </p>
            </Panel>

            <Panel title="Permissions for your role" icon="policy">
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {permissions.map((permission) => (
                  <li key={permission} className="flex items-start gap-1.5 font-body text-body-sm text-on-surface-variant">
                    <Icon name="check_circle" size={15} className="mt-0.5 text-success" />
                    {permission}
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-start gap-2 border-t border-line pt-2 font-body text-[11px] leading-relaxed text-outline">
                <Icon name="info" size={14} className="mt-0.5 shrink-0" />
                Role permissions are enforced by the API on every request. {isAdmin
                  ? 'Owner/admin roles also unlock the membership directory.'
                  : 'Elevating a role requires a backend change; there is no self-service role editor.'}
              </div>
            </Panel>
          </div>

          <aside className="flex min-w-0 flex-col gap-gutter lg:col-span-4">
            <Panel title="Retrieval engine" icon="hub" meta="On demand">
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-body text-body-sm text-on-surface-variant">Embedding service</span>
                  <Badge tone={data?.health?.healthy ? 'ok' : 'warn'}>
                    {data?.health?.healthy ? 'online' : 'unavailable'}
                  </Badge>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-body text-body-sm text-on-surface-variant">Provider</span>
                  <span className="font-mono text-[11px] text-on-surface">
                    {data?.health?.provider ?? '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-body text-body-sm text-on-surface-variant">Model</span>
                  <span className="font-mono text-[11px] text-on-surface">
                    {data?.health?.model ?? '—'}
                    {data?.health?.dimensions ? ` · ${data.health.dimensions}d` : ''}
                  </span>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between font-mono text-label-sm text-outline">
                    <span>Health probe</span>
                    <span>{data?.health?.healthy ? 'reachable' : 'failed'}</span>
                  </div>
                  <div className="font-body text-[11px] leading-relaxed text-outline">
                    Checks that the configured embedding provider answers and has its model available.
                    It does not run a retrieval.
                  </div>
                </div>
                <div className="border-t border-line pt-2">
                  <div className="mono-label text-outline">Endpoint</div>
                  <div className="mt-0.5 break-all font-mono text-[10px] text-on-surface-variant">
                    {data?.health?.endpoint ?? 'not reported'}
                  </div>
                </div>
                <div className="border-t border-line pt-2">
                  <div className="mono-label text-outline">API</div>
                  <div className="mt-0.5 font-mono text-[10px] text-on-surface-variant">
                    {data?.status?.service ?? 'ops-copilot'} · v{data?.status?.version ?? '—'}
                  </div>
                </div>
                {data?.healthError ? (
                  <div className="rounded border border-warning-line bg-warning-surface px-2 py-1.5 font-body text-[11px] text-warning-ink">
                    {data.healthError}
                  </div>
                ) : null}
              </div>
            </Panel>

            <Panel title="Retrieval guarantees" icon="verified_user">
              <ul className="space-y-2 font-body text-body-sm text-on-surface-variant">
                {[
                  'Cosine similarity search over organization-scoped chunks.',
                  'Minimum similarity threshold enforced by the retrieval service.',
                  'Answers cite the exact chunks used and report confidence.',
                  'No cross-tenant context is ever retrieved.',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-1.5">
                    <Icon name="done" size={14} className="mt-0.5 text-primary" />
                    {item}
                  </li>
                ))}
              </ul>
            </Panel>

            <div className="panel p-md">
              <div className="mb-2 flex items-center gap-1.5">
                <Icon name="report" size={16} className="text-outline" />
                <h2 className="font-headline-sm text-headline-sm text-on-surface">Not configurable via API</h2>
              </div>
              <ul className="space-y-1 font-body text-body-sm text-on-surface-variant">
                {[
                  'Workspace naming and retention',
                  'Webhook and alerting endpoints',
                  'Similarity threshold / chunk sizing',
                  'Vector re-index or purge actions',
                  'SSO, API keys and audit history',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-1.5">
                    <Icon name="remove" size={14} className="mt-0.5 text-outline" />
                    {item}
                  </li>
                ))}
              </ul>
              <p className="mt-2 border-t border-line pt-2 font-body text-[11px] leading-relaxed text-outline">
                These would require new backend endpoints. They are listed to document the gap rather
                than expose controls that would not persist.
              </p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
