import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApiData } from '../lib/hooks';
import { downloadText, formatDateTime, initials, shortId, titleCase } from '../lib/format';
import type { MembersResponse } from '../lib/types';
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  Panel,
  Tabs,
  buttonClass,
} from '../components/ui';
import type { BadgeTone } from '../components/ui';

function roleTone(role: string): BadgeTone {
  if (role === 'owner') return 'ai';
  if (role === 'admin') return 'primary';
  return 'neutral';
}

const MATRIX: { capability: string; route: string; owner: boolean; admin: boolean; member: boolean }[] = [
  { capability: 'Read logs, tickets and documents', route: 'GET /logs, /tickets, /documents', owner: true, admin: true, member: true },
  { capability: 'Ingest logs and tickets', route: 'POST /logs/ingest, /tickets/ingest', owner: true, admin: true, member: true },
  { capability: 'Upload and index documents', route: 'POST /documents/upload', owner: true, admin: true, member: true },
  { capability: 'Semantic search and RAG answers', route: 'POST /ai/search, /ai/ask', owner: true, admin: true, member: true },
  { capability: 'Organization member directory', route: 'GET /admin/members', owner: true, admin: true, member: false },
  { capability: 'Admin access check', route: 'GET /admin-test', owner: true, admin: true, member: false },
  { capability: 'Invite / remove members', route: 'not implemented', owner: false, admin: false, member: false },
  { capability: 'Change member roles', route: 'not implemented', owner: false, admin: false, member: false },
];

export function Admin() {
  const navigate = useNavigate();
  const { session, role, isAdmin, logout } = useAuth();
  const [tab, setTab] = useState<'members' | 'matrix'>('members');
  const [query, setQuery] = useState('');

  const { data, loading, error, reload } = useApiData<MembersResponse | null>(
    () => (isAdmin ? api.admin.members() : Promise.resolve(null)),
    [isAdmin]
  );

  const members = data?.members ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return members;
    return members.filter((member) =>
      `${member.email} ${member.role}`.toLowerCase().includes(needle)
    );
  }, [members, query]);

  const counts = useMemo(
    () => ({
      owners: members.filter((member) => member.role === 'owner').length,
      admins: members.filter((member) => member.role === 'admin').length,
      responders: members.filter((member) => member.role === 'member').length,
    }),
    [members]
  );

  if (!isAdmin) {
    return (
      <div className="space-y-5">
        <PageHeader
          eyebrow={
            <>
              <span className="eyebrow">Organization &amp; access</span>
              <span className="h-1 w-1 rounded-full bg-outline" />
              <Badge tone="warn">restricted</Badge>
            </>
          }
          title="Admin & Role-Based Access Control"
          description="Membership administration requires an owner or admin role in the active organization."
        />
        <Panel>
          <EmptyState
            icon="lock"
            title="Admin access is not available for your role"
            description={`Your membership role is "${titleCase(role ?? 'member')}". The API enforces this with requireRole(["owner","admin"]) on the admin directory, so this page never bypasses authorization.`}
            action={
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => navigate('/')}>
                  Back to command center
                </Button>
                <Button variant="ghost" size="sm" onClick={() => navigate('/settings')}>
                  View your permissions
                </Button>
              </div>
            }
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <>
            <span className="eyebrow">Organization &amp; access</span>
            <span className="h-1 w-1 rounded-full bg-outline" />
            <span className="font-mono text-label-sm uppercase tracking-wider text-primary">
              RBAC configuration
            </span>
            <Badge tone="ai">JWT session</Badge>
            <Badge tone="ok">org isolation enforced</Badge>
          </>
        }
        title="Admin & Role-Based Access Control"
        description="The membership directory and effective permissions for this organization, read from the API and the RBAC middleware that secures each route."
        actions={
          <>
            <Button
              variant="secondary"
              icon="download"
              disabled={members.length === 0}
              onClick={() =>
                downloadText(
                  `opspilot-members-${new Date().toISOString().slice(0, 10)}.json`,
                  JSON.stringify(data, null, 2),
                  'application/json'
                )
              }
            >
              Export members
            </Button>
            <Button variant="secondary" icon="refresh" onClick={() => void reload()} disabled={loading}>
              Refresh
            </Button>
          </>
        }
      />

      <div className="panel grid grid-cols-2 divide-x divide-y divide-line overflow-hidden md:grid-cols-4 md:divide-y-0">
        {[
          { label: 'Members', value: members.length, hint: 'Active memberships', icon: 'group' },
          { label: 'Owners', value: counts.owners, hint: 'Full organization control', icon: 'workspace_premium' },
          { label: 'Admins', value: counts.admins, hint: 'Admin directory access', icon: 'admin_panel_settings' },
          { label: 'Responders', value: counts.responders, hint: 'Member-role access', icon: 'person' },
        ].map((stat) => (
          <div key={stat.label} className="flex flex-col justify-between gap-2 bg-surface p-md">
            <div className="flex items-start justify-between">
              <span className="mono-label text-outline">{stat.label}</span>
              <Icon name={stat.icon} size={16} className="text-outline" />
            </div>
            <span className="font-headline-md text-headline-md font-bold tabular text-on-surface">{stat.value}</span>
            <span className="font-body text-body-sm text-on-surface-variant">{stat.hint}</span>
          </div>
        ))}
      </div>

      {error ? <ErrorState message={error} onRetry={() => void reload()} /> : null}

      <div className="grid items-start gap-gutter-desktop xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-8">
          <Panel flush>
            <Tabs
              className="px-md pt-1"
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'members', label: 'Members & permissions', count: members.length, icon: 'group' },
                { id: 'matrix', label: 'Role matrix', icon: 'grid_on' },
              ]}
            />

            {tab === 'members' ? (
              <>
                <div className="flex flex-col gap-2 border-b border-line p-md sm:flex-row sm:items-center">
                  <div className="relative flex-1">
                    <Icon name="search" size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Filter by email or role…"
                      className="input pl-9"
                      aria-label="Filter members"
                    />
                  </div>
                  <span className="font-mono text-label-sm text-outline">
                    {filtered.length} of {members.length} memberships
                  </span>
                </div>

                {loading && !data ? (
                  <div className="px-4 py-10 text-center font-body text-body-sm text-outline">
                    Loading membership directory…
                  </div>
                ) : filtered.length === 0 ? (
                  <EmptyState
                    compact
                    icon="group_off"
                    title={members.length === 0 ? 'No members returned' : 'No members match that filter'}
                    description={
                      members.length === 0
                        ? 'The organization has no memberships recorded.'
                        : 'Try a different email fragment or role.'
                    }
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-left">
                      <thead>
                        <tr className="border-b border-outline-variant bg-surface-low">
                          <th className="px-3 py-2 mono-label text-on-surface-variant">Member</th>
                          <th className="w-[130px] px-3 py-2 mono-label text-on-surface-variant">Role</th>
                          <th className="w-[170px] px-3 py-2 mono-label text-on-surface-variant">Joined</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {filtered.map((member) => {
                          const isYou = member.userId === session?.user.id;
                          return (
                            <tr key={member.userId} className="row-hover">
                              <td className="px-3 py-2.5">
                                <div className="flex items-center gap-2">
                                  <span className="flex h-8 w-8 items-center justify-center rounded bg-primary-fixed font-mono text-[10px] font-bold text-primary">
                                    {initials(member.email)}
                                  </span>
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-1.5">
                                      <span className="truncate font-label-lg text-label-lg font-semibold text-on-surface">
                                        {member.email}
                                      </span>
                                      {isYou ? <Badge tone="primary">you</Badge> : null}
                                    </div>
                                    <div className="flex items-center gap-1 font-mono text-[10px] text-outline">
                                      {shortId(member.userId, 10)}
                                      <CopyButton value={member.userId} label="" />
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-3 py-2.5">
                                <Badge tone={roleTone(member.role)}>{titleCase(member.role)}</Badge>
                              </td>
                              <td className="px-3 py-2.5 font-mono text-[11px] text-outline">
                                {formatDateTime(member.joinedAt)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="border-t border-line px-md py-2.5 font-body text-[11px] leading-relaxed text-outline">
                  Membership records are read-only here. The API does not expose invitation, removal or
                  role-change endpoints; adding them requires new backend functionality.
                </div>
              </>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-left">
                  <thead>
                    <tr className="border-b border-outline-variant bg-surface-low">
                      <th className="px-3 py-2 mono-label text-on-surface-variant">Capability</th>
                      <th className="w-[80px] px-3 py-2 text-center mono-label text-on-surface-variant">Owner</th>
                      <th className="w-[80px] px-3 py-2 text-center mono-label text-on-surface-variant">Admin</th>
                      <th className="w-[80px] px-3 py-2 text-center mono-label text-on-surface-variant">Member</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {MATRIX.map((row) => (
                      <tr key={row.capability} className="row-hover">
                        <td className="px-3 py-2.5">
                          <div className="font-label-lg text-label-lg font-semibold text-on-surface">
                            {row.capability}
                          </div>
                          <div className="font-mono text-[10px] text-outline">{row.route}</div>
                        </td>
                        {[row.owner, row.admin, row.member].map((allowed, index) => (
                          <td key={index} className="px-3 py-2.5 text-center">
                            {row.route === 'not implemented' ? (
                              <span className="font-mono text-[10px] uppercase text-outline">—</span>
                            ) : allowed ? (
                              <Icon name="check_circle" size={16} className="mx-auto text-success" />
                            ) : (
                              <Icon name="block" size={16} className="mx-auto text-outline" />
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="border-t border-line px-md py-2.5 font-body text-[11px] leading-relaxed text-outline">
                  Derived from the deployed Express routes and middleware. A role change is enforced
                  server-side on the next request; this UI is informational only.
                </p>
              </div>
            )}
          </Panel>
        </div>

        <aside className="flex min-w-0 flex-col gap-gutter xl:col-span-4">
          <Panel title="Active session" icon="badge">
            <dl className="space-y-2">
              {[
                ['Organization', session?.organization.name ?? '—'],
                ['Organization ID', session?.organization.id ?? '—'],
                ['Signed in as', session?.user.email ?? '—'],
                ['Role', titleCase(role ?? 'member')],
              ].map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-2">
                  <dt className="mono-label text-outline">{label}</dt>
                  <dd className="max-w-[60%] break-words text-right font-mono text-[11px] text-on-surface">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-2">
              <Button
                size="sm"
                variant="secondary"
                icon="settings"
                onClick={() => navigate('/settings')}
              >
                Workspace settings
              </Button>
              <Button size="sm" variant="ghost" icon="logout" onClick={logout}>
                Sign out
              </Button>
            </div>
          </Panel>

          <div className="panel p-md">
            <div className="mb-2 flex items-center gap-1.5">
              <Icon name="report" size={16} className="text-warning-ink" />
              <h2 className="font-headline-sm text-headline-sm text-on-surface">Not exposed by this API</h2>
            </div>
            <p className="font-body text-body-sm text-on-surface-variant">
              The design includes these admin surfaces, but the backend has no routes for them. They are
              intentionally absent rather than simulated:
            </p>
            <ul className="mt-2 space-y-1 font-body text-body-sm text-on-surface-variant">
              {[
                'Member invitations and role changes',
                'API keys and service accounts',
                'SSO / SAML configuration',
                'Security audit log export',
                'Session revocation controls',
              ].map((item) => (
                <li key={item} className="flex items-start gap-1.5">
                  <Icon name="remove" size={14} className="mt-0.5 text-outline" />
                  {item}
                </li>
              ))}
            </ul>
            <button className={clsx(buttonClass('secondary', 'sm'), 'mt-3 w-full')} onClick={() => navigate('/documents')}>
              <Icon name="library_books" size={15} /> Manage knowledge instead
            </button>
          </div>

          {error ? (
            <Panel title="Diagnostics" icon="monitor_heart">
              <p className="break-words font-mono text-[11px] text-on-surface-variant">{error}</p>
              <Button className="mt-2" size="sm" variant="secondary" icon="refresh" onClick={() => void reload()}>
                Retry directory
              </Button>
            </Panel>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
