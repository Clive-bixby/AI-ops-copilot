import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { useApiData, useDebouncedValue } from '../lib/hooks';
import { formatDateTime, relativeTime, shortId, titleCase } from '../lib/format';
import type { AskResponse, Ticket } from '../lib/types';
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  InlineError,
  Modal,
  PageHeader,
  Pagination,
  Panel,
  buttonClass,
  priorityTone,
  statusTone,
} from '../components/ui';
import { AiText } from '../components/AiText';

const STATUSES = ['open', 'pending', 'in_progress', 'resolved', 'closed'] as const;
const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const isOpen = (ticket: Ticket) => !['resolved', 'closed'].includes((ticket.status || 'open').toLowerCase());

type TriageState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'done'; response: AskResponse }
  | { phase: 'error'; message: string };

function TicketCard({
  ticket,
  active,
  onSelect,
  onTriage,
}: {
  ticket: Ticket;
  active: boolean;
  onSelect: () => void;
  onTriage: () => void;
}) {
  const priority = (ticket.priority || 'medium').toLowerCase();
  const accent =
    priority === 'urgent'
      ? 'border-l-error'
      : priority === 'high'
        ? 'border-l-secondary'
        : priority === 'medium'
          ? 'border-l-warning'
          : 'border-l-outline-variant';

  return (
    <button
      onClick={onSelect}
      className={clsx(
        'group flex w-full flex-col gap-1.5 border-l-[3px] px-md py-3 text-left transition-colors',
        accent,
        active ? 'bg-primary-fixed/35' : 'bg-surface hover:bg-surface-low'
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={priorityTone(ticket.priority)}>{titleCase(ticket.priority)}</Badge>
        <span className="font-mono text-label-sm text-outline">INC-{shortId(ticket.id, 6)}</span>
        <span className="font-mono text-label-sm text-outline">· {relativeTime(ticket.created_at)}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <Badge tone={statusTone(ticket.status)}>{titleCase(ticket.status)}</Badge>
          <Icon name="chevron_right" size={15} className="text-outline" />
        </span>
      </div>
      <h3 className="font-label-lg text-label-lg font-semibold text-on-surface group-hover:text-primary">
        {ticket.title}
      </h3>
      {ticket.description ? (
        <p className="line-clamp-2 font-body text-body-sm text-on-surface-variant">{ticket.description}</p>
      ) : null}
      <div className="mt-0.5 flex items-center gap-2 border-t border-line pt-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
          {isOpen(ticket) ? 'Awaiting triage' : 'Closed out'}
        </span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onTriage();
          }}
          className="ml-auto flex items-center gap-1 font-mono text-label-sm font-semibold text-ai-ink hover:underline"
        >
          <Icon name="neurology" size={12} /> Copilot triage
        </button>
      </div>
    </button>
  );
}

export function Tickets() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data, loading, error, reload } = useApiData<Ticket[]>(() => api.tickets.list(), []);
  const tickets = data ?? [];

  const [view, setView] = useState<'list' | 'kanban'>('list');
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState('all');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState<'newest' | 'priority'>('newest');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('ticket'));
  const debouncedQuery = useDebouncedValue(query, 180);
  const pageSize = 10;

  const [triage, setTriage] = useState<TriageState>({ phase: 'idle' });
  const [triageTicketId, setTriageTicketId] = useState<string | null>(null);

  const [ingestOpen, setIngestOpen] = useState(false);
  const [ingestText, setIngestText] = useState('');
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestSuccess, setIngestSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (tickets.length > 0 && !selectedId) setSelectedId(tickets[0]?.id ?? null);
  }, [tickets, selectedId]);

  useEffect(() => {
    const target = searchParams.get('ticket');
    if (target) setSelectedId(target);
  }, [searchParams]);

  const counts = useMemo(() => {
    const openTickets = tickets.filter(isOpen);
    return {
      total: tickets.length,
      open: openTickets.length,
      urgent: openTickets.filter((ticket) =>
        ['urgent', 'critical'].includes((ticket.priority || '').toLowerCase())
      ).length,
      high: openTickets.filter((ticket) => (ticket.priority || '').toLowerCase() === 'high').length,
      resolved: tickets.filter((ticket) =>
        ['resolved', 'closed'].includes((ticket.status || '').toLowerCase())
      ).length,
    };
  }, [tickets]);

  const filtered = useMemo(() => {
    const needle = debouncedQuery.trim().toLowerCase();
    const result = tickets.filter((ticket) => {
      if (priority !== 'all' && (ticket.priority || '').toLowerCase() !== priority) return false;
      if (status !== 'all' && (ticket.status || '').toLowerCase() !== status) return false;
      if (!needle) return true;
      return [ticket.title, ticket.description, ticket.id, ticket.status, ticket.priority]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });

    if (sort === 'priority') {
      return [...result].sort(
        (a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
      );
    }
    return result;
  }, [tickets, priority, status, debouncedQuery, sort]);

  useEffect(() => {
    setPage(1);
  }, [priority, status, debouncedQuery, sort]);

  const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);
  const selected = tickets.find((ticket) => ticket.id === selectedId) ?? null;

  const resetFilters = () => {
    setQuery('');
    setPriority('all');
    setStatus('all');
    setSort('newest');
  };

  const runTriage = async (ticket: Ticket) => {
    setSelectedId(ticket.id);
    setTriageTicketId(ticket.id);
    setTriage({ phase: 'loading' });

    const question = `Triage this operational incident: "${ticket.title}". ${
      ticket.description || ''
    } Using the indexed runbooks, logs and related tickets, explain the likely cause, the evidence you found, and the first checks an on-call engineer should run.`;

    try {
      const response = await api.ai.ask(question);
      setTriage({ phase: 'done', response });
    } catch (caught) {
      setTriage({ phase: 'error', message: errorMessage(caught) });
    }
  };

  const submitIngest = async () => {
    setIngestError(null);
    setIngestSuccess(null);
    const trimmed = ingestText.trim();
    if (!trimmed) {
      setIngestError('Paste a JSON array, an object, or CSV with a header row.');
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      payload = { csv: trimmed };
    }

    setIngesting(true);
    try {
      const result = await api.tickets.ingest(payload);
      setIngestText('');
      setIngestSuccess(`Ingested ${result.count} ${result.count === 1 ? 'ticket' : 'tickets'}.`);
      await reload(true);
    } catch (caught) {
      setIngestError(errorMessage(caught));
    } finally {
      setIngesting(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <>
            <span className="eyebrow">Operations cockpit</span>
            <span className="h-1 w-1 rounded-full bg-outline" />
            <span className="font-mono text-label-sm uppercase tracking-wider text-primary">
              Incident stream
            </span>
            {counts.urgent > 0 ? (
              <Badge tone="critical" pulse>
                {counts.urgent} urgent open
              </Badge>
            ) : (
              <Badge tone="ok">no urgent open</Badge>
            )}
          </>
        }
        title="Incidents & Operational Tickets"
        description="Every ticket ingested for this organization, with priority and status filters plus grounded copilot triage for each record."
        actions={
          <>
            <div className="flex items-center rounded border border-outline-variant bg-surface-low p-0.5">
              {(['list', 'kanban'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setView(mode)}
                  aria-pressed={view === mode}
                  className={clsx(
                    'flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 font-label-lg text-label-lg transition-colors',
                    view === mode
                      ? 'bg-surface text-primary shadow-sm'
                      : 'text-on-surface-variant hover:text-on-surface'
                  )}
                >
                  <Icon name={mode === 'list' ? 'view_list' : 'view_kanban'} size={15} />
                  {mode === 'list' ? 'List' : 'Kanban'}
                </button>
              ))}
            </div>
            <Button icon="add_alert" onClick={() => setIngestOpen(true)}>
              Ingest tickets
            </Button>
          </>
        }
      />

      {error && !data ? (
        <ErrorState message={error} onRetry={() => void reload()} />
      ) : (
        <>
          <div className="panel grid grid-cols-2 divide-x divide-y divide-line overflow-hidden md:grid-cols-4 md:divide-y-0">
            {[
              {
                label: 'Active criticals',
                value: counts.urgent,
                hint: counts.high > 0 ? `${counts.high} high priority open` : 'No high priority open',
                tone: counts.urgent > 0 ? 'text-secondary' : 'text-on-surface',
                badge: counts.urgent > 0 ? <Badge tone="critical">urgent</Badge> : <Badge tone="ok">stable</Badge>,
              },
              {
                label: 'Open tickets',
                value: counts.open,
                hint: 'Not resolved or closed',
                tone: 'text-on-surface',
                badge: <Badge tone="primary">queued</Badge>,
              },
              {
                label: 'Resolved / closed',
                value: counts.resolved,
                hint: 'Retained in the workspace',
                tone: 'text-success-ink',
                badge: <Badge tone="ok">complete</Badge>,
              },
              {
                label: 'Total tickets',
                value: counts.total,
                hint: 'All ingested records',
                tone: 'text-on-surface',
                badge: <Badge tone="neutral">org scoped</Badge>,
              },
            ].map((stat) => (
              <div key={stat.label} className="flex flex-col justify-between gap-2 bg-surface p-md">
                <span className="mono-label text-outline">{stat.label}</span>
                <div className="flex items-baseline gap-2">
                  <span className={clsx('font-headline-md text-headline-md font-bold tabular', stat.tone)}>
                    {stat.value}
                  </span>
                  {stat.badge}
                </div>
                <span className="font-body text-body-sm text-on-surface-variant">{stat.hint}</span>
              </div>
            ))}
          </div>

          <div className="panel flex flex-col gap-2 p-md md:flex-row md:items-center">
            <div className="relative flex-1">
              <Icon name="search" size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by title, description or ticket id…"
                className="input pl-9"
                aria-label="Filter tickets"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
                className="select w-[150px]"
                aria-label="Filter by priority"
              >
                <option value="all">Priority: all</option>
                {PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {titleCase(value)}
                  </option>
                ))}
              </select>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                className="select w-[150px]"
                aria-label="Filter by status"
              >
                <option value="all">Status: all</option>
                {STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {titleCase(value)}
                  </option>
                ))}
              </select>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as 'newest' | 'priority')}
                className="select w-[150px]"
                aria-label="Sort tickets"
              >
                <option value="newest">Newest first</option>
                <option value="priority">Priority first</option>
              </select>
              <Button variant="ghost" size="sm" icon="filter_alt_off" onClick={resetFilters}>
                Reset
              </Button>
            </div>
          </div>

          <div className="grid items-start gap-gutter-desktop xl:grid-cols-12">
            <div className="min-w-0 xl:col-span-8">
              <Panel
                title={view === 'list' ? 'Incident stream' : 'Kanban board'}
                icon={view === 'list' ? 'view_list' : 'view_kanban'}
                meta={`${filtered.length} of ${tickets.length}`}
                flush
                actions={
                  <Button variant="secondary" size="sm" icon="refresh" onClick={() => void reload()} disabled={loading}>
                    Refresh
                  </Button>
                }
              >
                {loading && !data ? (
                  <div className="px-4 py-12 text-center font-body text-body-sm text-outline">Loading tickets…</div>
                ) : filtered.length === 0 ? (
                  <EmptyState
                    icon="confirmation_number"
                    title={tickets.length === 0 ? 'No tickets ingested yet' : 'No tickets match these filters'}
                    description={
                      tickets.length === 0
                        ? 'POST /tickets/ingest accepts JSON arrays, single objects, or CSV with a title column.'
                        : 'Adjust the priority, status or text filters to widen the stream.'
                    }
                    action={
                      tickets.length === 0 ? (
                        <Button size="sm" icon="upload" onClick={() => setIngestOpen(true)}>
                          Ingest tickets
                        </Button>
                      ) : (
                        <Button size="sm" variant="secondary" onClick={resetFilters}>
                          Reset filters
                        </Button>
                      )
                    }
                  />
                ) : view === 'kanban' ? (
                  <div className="flex gap-px overflow-x-auto bg-line">
                    {STATUSES.map((column) => {
                      const items = filtered.filter(
                        (ticket) => (ticket.status || 'open').toLowerCase() === column
                      );
                      return (
                        <div key={column} className="min-w-[220px] flex-1 bg-surface-low">
                          <div className="flex items-center justify-between border-b border-line bg-surface px-2.5 py-2">
                            <span className="mono-label text-on-surface-variant">{titleCase(column)}</span>
                            <span className="rounded bg-surface-container px-1 font-mono text-[10px] tabular text-on-surface-variant">
                              {items.length}
                            </span>
                          </div>
                          <div className="space-y-1.5 p-1.5">
                            {items.map((ticket) => (
                              <button
                                key={ticket.id}
                                onClick={() => setSelectedId(ticket.id)}
                                className={clsx(
                                  'w-full rounded border border-outline-variant/70 bg-surface p-2 text-left transition-colors hover:border-primary/40',
                                  ticket.id === selectedId ? 'border-primary/50 bg-primary-fixed/25' : ''
                                )}
                              >
                                <div className="mb-1 flex items-center justify-between gap-1">
                                  <span className="font-mono text-[10px] text-outline">
                                    INC-{shortId(ticket.id, 6)}
                                  </span>
                                  <Badge tone={priorityTone(ticket.priority)}>{ticket.priority}</Badge>
                                </div>
                                <div className="line-clamp-2 font-label-lg text-label-lg font-semibold text-on-surface">
                                  {ticket.title}
                                </div>
                                <div className="mt-1 font-mono text-[10px] text-outline">
                                  {relativeTime(ticket.created_at)}
                                </div>
                              </button>
                            ))}
                            {items.length === 0 ? (
                              <div className="px-2 py-6 text-center font-body text-body-sm text-outline">
                                Empty
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <>
                    <div className="divide-y divide-line">
                      {pageItems.map((ticket) => (
                        <TicketCard
                          key={ticket.id}
                          ticket={ticket}
                          active={ticket.id === selectedId}
                          onSelect={() => setSelectedId(ticket.id)}
                          onTriage={() => void runTriage(ticket)}
                        />
                      ))}
                    </div>
                    <Pagination page={page} pageSize={pageSize} total={filtered.length} onPage={setPage} label="tickets" />
                  </>
                )}
              </Panel>
            </div>

            <div className="min-w-0 xl:col-span-4">
              <div className="sticky top-[72px]">
                {selected ? (
                  <div className="panel overflow-hidden">
                    <div className="flex items-start justify-between gap-2 border-b border-line bg-surface-low px-md py-2.5">
                      <div className="min-w-0">
                        <div className="eyebrow">Incident inspector</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-code-sm font-semibold text-on-surface">
                            INC-{shortId(selected.id, 6)}
                          </span>
                          <CopyButton value={selected.id} label="ID" />
                        </div>
                      </div>
                      <Badge tone={priorityTone(selected.priority)}>{titleCase(selected.priority)}</Badge>
                    </div>

                    <div className="space-y-3 p-md">
                      <div>
                        <h2 className="font-headline-sm text-headline-sm text-on-surface">{selected.title}</h2>
                        <p className="mt-1 whitespace-pre-wrap font-body text-body-sm leading-relaxed text-on-surface-variant">
                          {selected.description || 'No description was supplied with this ticket.'}
                        </p>
                      </div>

                      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-y border-line py-2">
                        {[
                          ['Status', titleCase(selected.status)],
                          ['Priority', titleCase(selected.priority)],
                          ['Created', formatDateTime(selected.created_at)],
                          ['Age', relativeTime(selected.created_at)],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <dt className="mono-label text-outline">{label}</dt>
                            <dd className="mt-0.5 font-mono text-[11px] text-on-surface">{value}</dd>
                          </div>
                        ))}
                      </dl>

                      <div className="ai-panel p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <Icon name="neurology" size={15} className="text-ai-ink" filled />
                            <span className="font-mono text-label-sm font-bold uppercase tracking-wider text-ai-ink">
                              Copilot triage
                            </span>
                          </div>
                          {triage.phase === 'done' && triageTicketId === selected.id ? (
                            <Badge tone={triage.response.confidence === 'high' ? 'ok' : triage.response.confidence === 'medium' ? 'warn' : 'critical'}>
                              {triage.response.confidence}
                            </Badge>
                          ) : null}
                        </div>

                        {triageTicketId !== selected.id || triage.phase === 'idle' ? (
                          <div className="mt-2 space-y-2">
                            <p className="font-body text-body-sm text-on-surface">
                              Retrieve grounded context for this ticket from indexed runbooks, logs and
                              related knowledge.
                            </p>
                            <Button size="sm" variant="ai" icon="auto_awesome" onClick={() => void runTriage(selected)}>
                              Run Copilot triage
                            </Button>
                          </div>
                        ) : triage.phase === 'loading' ? (
                          <div className="mt-2 flex items-center gap-2 font-body text-body-sm text-ai-ink">
                            <Icon name="sync" size={15} className="animate-spin" /> Analyzing…
                          </div>
                        ) : triage.phase === 'error' ? (
                          <div className="mt-2">
                            <InlineError message={triage.message} onRetry={() => void runTriage(selected)} />
                          </div>
                        ) : (
                          <div className="mt-2 space-y-2">
                            <AiText
                              text={triage.response.answer}
                              className="text-body-sm"
                            />
                            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ai-border pt-2">
                              <span className="font-mono text-label-sm text-ai-ink">
                                {triage.response.sourceCount} sources · {Math.round(triage.response.metrics.totalMs)}ms
                              </span>
                              <button
                                onClick={() =>
                                  navigate(
                                    `/copilot?q=${encodeURIComponent(`Investigate the incident "${selected.title}"`)}`
                                  )
                                }
                                className="font-mono text-label-sm font-semibold text-ai-ink hover:underline"
                              >
                                Open investigation →
                              </button>
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          icon="search"
                          onClick={() => navigate(`/search?q=${encodeURIComponent(selected.title)}`)}
                        >
                          Search knowledge
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="terminal"
                          onClick={() =>
                            navigate(`/logs?q=${encodeURIComponent(selected.title.split(' ').slice(0, 3).join(' '))}`)
                          }
                        >
                          Related logs
                        </Button>
                      </div>

                      <p className="border-t border-line pt-2 font-body text-[11px] leading-relaxed text-outline">
                        Ticket status and assignment are read-only here: the current API exposes ticket
                        ingestion and listing, not mutation endpoints.
                      </p>
                    </div>
                  </div>
                ) : (
                  <Panel title="Incident inspector" icon="frame_inspect">
                    <EmptyState
                      compact
                      icon="touch_app"
                      title="Select a ticket"
                      description="Choose a ticket from the stream to inspect it and run grounded copilot triage."
                    />
                  </Panel>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <Modal
        open={ingestOpen}
        onClose={() => setIngestOpen(false)}
        title="Ingest tickets"
        description="POST /tickets/ingest accepts a JSON array, a { tickets: [...] } envelope, a single object, or CSV with title, description, status and priority columns."
        footer={
          <>
            <Button variant="ghost" onClick={() => setIngestOpen(false)}>
              Close
            </Button>
            <Button icon="upload" onClick={() => void submitIngest()} disabled={ingesting}>
              {ingesting ? 'Ingesting…' : 'Ingest tickets'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field
            label="Payload"
            hint="Supported statuses: open, pending, in_progress, resolved, closed. Priorities: low, medium, high, urgent."
          >
            <textarea
              value={ingestText}
              onChange={(event) => setIngestText(event.target.value)}
              placeholder={'title,description,status,priority\nCheckout 504,Card payment times out,open,urgent'}
              className="input min-h-[200px] font-mono text-code-sm"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <label className={buttonClass('secondary', 'sm')}>
              <Icon name="folder_open" size={15} /> Load a .csv or .json file
              <input
                type="file"
                accept=".csv,.json,.txt"
                className="hidden"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    try {
                      setIngestText(await file.text());
                      setIngestError(null);
                    } catch {
                      setIngestError('Could not read that file.');
                    }
                  }
                  event.target.value = '';
                }}
              />
            </label>
            <span className="font-body text-body-sm text-outline">Files are read locally in the browser.</span>
          </div>
          {ingestError ? <InlineError message={ingestError} /> : null}
          {ingestSuccess ? (
            <div className="flex items-center gap-1.5 rounded border border-success-line bg-success-surface px-3 py-2 font-body text-body-sm text-success-ink">
              <Icon name="check_circle" size={15} /> {ingestSuccess}
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
