import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApiData, useInterval } from '../lib/hooks';
import { formatNumber, formatTime, relativeTime, shortId, titleCase } from '../lib/format';
import type {
  ApiHealth,
  AskResponse,
  LogEntry,
  Overview,
  SystemStatus,
  Ticket,
} from '../lib/types';
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  ErrorState,
  Icon,
  InlineError,
  LoadingState,
  PageHeader,
  Panel,
  Progress,
  Skeleton,
  Stat,
  buttonClass,
  levelTone,
  priorityTone,
  statusTone,
} from '../components/ui';
import { AiText } from '../components/AiText';

interface DashboardData {
  overview: Overview;
  logs: LogEntry[];
  tickets: Ticket[];
  health: ApiHealth | null;
  status: SystemStatus | null;
}

const PRIORITY_RANK: Record<string, number> = {
  urgent: 0,
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const isOpen = (ticket: Ticket) =>
  !['resolved', 'closed'].includes((ticket.status || 'open').toLowerCase());

type TriageState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'done'; response: AskResponse }
  | { phase: 'error'; message: string };

export function Dashboard() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const { data, loading, error, reload } = useApiData<DashboardData>(async () => {
    const [overview, logs, tickets, health, status] = await Promise.all([
      api.insights.overview(),
      api.logs.list(),
      api.tickets.list(),
      api.ai.health().catch(() => null),
      api.status().catch(() => null),
    ]);
    return { overview, logs, tickets, health, status };
  }, []);

  useInterval(
    () => {
      void reload(true);
    },
    autoRefresh ? 30_000 : null
  );

  useEffect(() => {
    if (data) setLastUpdated(new Date());
  }, [data]);

  const [triage, setTriage] = useState<TriageState>({ phase: 'idle' });
  const [triageTicketId, setTriageTicketId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tickets = data?.tickets ?? [];
  const openTickets = tickets.filter(isOpen);
  const primaryTicket = [...openTickets].sort(
    (a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
  )[0];
  const latestLogs = data?.logs.slice(0, 6) ?? [];
  const latestTickets = tickets.slice(0, 4);
  const overview = data?.overview;

  const runTriage = async (ticket: Ticket) => {
    setTriageTicketId(ticket.id);
    setTriage({ phase: 'loading' });
    const question = `Triage this operational incident: "${ticket.title}". ${
      ticket.description || ''
    } Based on the indexed runbooks, logs and tickets, what is the likely cause and what should the on-call engineer check first?`;

    try {
      const response = await api.ai.ask(question);
      if (!response.answer || response.answer === 'No reliable operational context found.') {
        setTriage({
          phase: 'error',
          message:
            'The copilot found no reliable indexed context for this incident. Add a runbook or ingest related logs and try again.',
        });
        return;
      }
      setTriage({ phase: 'done', response });
    } catch (caught) {
      setTriage({ phase: 'error', message: errorMessage(caught) });
    }
  };

  const uploadDocument = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    setUploadSuccess(null);
    try {
      await api.documents.upload(file);
      setUploadSuccess(`${file.name} uploaded and processed.`);
      await reload(true);
    } catch (caught) {
      setUploadError(errorMessage(caught));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-5">
        <div className="space-y-3">
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-9 w-96 max-w-full" />
        </div>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-outline-variant bg-outline-variant md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="bg-surface p-md">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-4 h-7 w-20" />
              <Skeleton className="mt-2 h-3 w-32" />
            </div>
          ))}
        </div>
        <div className="grid gap-gutter-desktop lg:grid-cols-12">
          <Skeleton className="h-96 lg:col-span-8" />
          <Skeleton className="h-96 lg:col-span-4" />
        </div>
      </div>
    );
  }

  if (error && !data) {
    return <ErrorState message={error} onRetry={() => void reload()} />;
  }

  if (!data || !overview) {
    return <LoadingState />;
  }

  const docTotal = overview.documents.total;
  const docHealthy = docTotal === 0 ? 0 : (overview.documents.processed / docTotal) * 100;

  return (
    <div className="space-y-5">
      {primaryTicket && (primaryTicket.priority === 'urgent' || primaryTicket.priority === 'high') ? (
        <div className="animate-enter flex flex-col gap-3 rounded border border-secondary/40 bg-secondary px-4 py-3 text-on-primary sm:flex-row sm:items-center sm:justify-between lg:px-5">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <span className="flex items-center gap-1.5 rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-secondary">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-secondary" />
              {primaryTicket.priority === 'urgent' ? 'SEV-1' : 'SEV-2'} active
            </span>
            <span className="min-w-0 truncate font-headline-sm text-headline-sm font-semibold">
              {primaryTicket.title}
            </span>
            <span className="hidden font-mono text-label-sm uppercase tracking-wider text-on-primary/80 sm:inline">
              INC-{shortId(primaryTicket.id, 6)} · opened {relativeTime(primaryTicket.created_at)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() =>
                navigate(`/copilot?q=${encodeURIComponent(`Triage the incident "${primaryTicket.title}"`)}`)
              }
              className="flex items-center gap-1.5 rounded bg-surface px-2.5 py-1.5 font-label-lg text-label-lg font-semibold text-secondary transition-colors hover:bg-surface-low"
            >
              <Icon name="bolt" size={15} />
              Triage with Copilot
            </button>
            <Link
              to={`/tickets?ticket=${primaryTicket.id}`}
              className="rounded border border-on-primary/30 px-2.5 py-1.5 font-label-lg text-label-lg text-on-primary transition-colors hover:bg-on-primary/10"
            >
              Open ticket
            </Link>
          </div>
        </div>
      ) : null}

      <PageHeader
        eyebrow={
          <>
            <span className="eyebrow">Autonomous runtime observability</span>
            <span className="h-1 w-1 rounded-full bg-outline" />
            <span className="font-mono text-label-sm uppercase tracking-wider text-primary">
              {session?.organization.name ?? 'Organization'}
            </span>
            <span className="hidden h-1 w-1 rounded-full bg-outline sm:inline" />
            <span className="hidden font-mono text-label-sm uppercase tracking-wider text-outline sm:inline">
              {data.status?.environment ?? 'api'} · {data.status?.service ?? 'ops-copilot'}
            </span>
            {lastUpdated ? (
              <span className="hidden font-mono text-label-sm uppercase tracking-wider text-outline lg:inline">
                · updated {formatTime(lastUpdated.toISOString())}
              </span>
            ) : null}
          </>
        }
        title="System Health & Operational Feed"
        description="Live counts, recent ingestion and grounded copilot analysis drawn directly from this organization’s logs, tickets and documents."
        actions={
          <>
            <button
              onClick={() => setAutoRefresh((value) => !value)}
              aria-pressed={autoRefresh}
              className={buttonClass('secondary', 'sm')}
              title="Toggle 30 second refresh"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${autoRefresh ? 'animate-pulse bg-success' : 'bg-outline'}`}
              />
              {autoRefresh ? 'Auto 30s' : 'Manual'}
            </button>
            <Button variant="secondary" size="sm" icon="refresh" onClick={() => void reload()}>
              Refresh
            </Button>
          </>
        }
      />

      {error ? <InlineError message={`Background refresh failed: ${error}`} onRetry={() => void reload()} /> : null}

      <div className="panel grid grid-cols-2 divide-x divide-y divide-line overflow-hidden md:grid-cols-4 md:divide-y-0">
        <Stat
          label="Documents"
          value={formatNumber(overview.documents.total)}
          icon="description"
          hint={`${overview.documents.processed} indexed · ${overview.documents.processing + overview.documents.pending} in pipeline`}
          badge={
            overview.documents.failed > 0 ? (
              <Badge tone="critical">{overview.documents.failed} failed</Badge>
            ) : undefined
          }
        />
        <Stat
          label="Log events"
          value={formatNumber(overview.logs.total)}
          icon="receipt_long"
          hint={`${overview.logs.errors} errors · ${overview.logs.warnings} warnings`}
          badge={<Badge tone={overview.logs.errors > 0 ? 'critical' : 'ok'}>org scoped</Badge>}
        />
        <Stat
          label="Open tickets"
          value={formatNumber(overview.tickets.open)}
          icon="confirmation_number"
          hint={`${formatNumber(overview.tickets.total)} tickets recorded`}
          badge={
            overview.tickets.urgentOpen > 0 ? (
              <Badge tone="accent" pulse>
                {overview.tickets.urgentOpen} urgent
              </Badge>
            ) : (
              <Badge tone="ok">stable</Badge>
            )
          }
        />
        <Stat
          label="AI engine"
          value={data.health?.healthy ? 'Online' : 'Degraded'}
          icon="neurology"
          tone={data.health?.healthy ? 'ai' : 'default'}
          hint={data.health?.healthy ? `${data.health.model} · model installed` : 'Embedding model unavailable'}
          badge={
            <Badge tone={data.health?.healthy ? 'ai' : 'warn'}>
              {data.health?.healthy ? 'embeddings online' : 'model missing'}
            </Badge>
          }
        />
      </div>

      <div className="grid items-start gap-gutter-desktop lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-gutter-desktop lg:col-span-8">
          <article className="panel overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-low px-md py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="eyebrow">Active incident dossier</span>
                {primaryTicket ? (
                  <>
                    <Badge tone={priorityTone(primaryTicket.priority)}>
                      {titleCase(primaryTicket.priority)}
                    </Badge>
                    <span className="font-mono text-label-sm text-outline">
                      INC-{shortId(primaryTicket.id, 6)}
                    </span>
                    <Badge tone={statusTone(primaryTicket.status)}>{titleCase(primaryTicket.status)}</Badge>
                  </>
                ) : null}
              </div>
              <div className="flex items-center gap-3 font-mono text-label-sm text-outline">
                {primaryTicket ? (
                  <>
                    <span>
                      Opened <strong className="text-on-surface">{relativeTime(primaryTicket.created_at)}</strong>
                    </span>
                    <span className="hidden text-outline-variant sm:inline">|</span>
                    <CopyButton value={primaryTicket.id} label="ID" />
                  </>
                ) : (
                  <span>No open incidents</span>
                )}
              </div>
            </div>

            {primaryTicket ? (
              <div className="flex flex-col gap-3 p-md sm:p-lg">
                <div>
                  <h2 className="font-headline-md text-headline-md tracking-tight text-on-surface">
                    {primaryTicket.title}
                  </h2>
                  <p className="mt-1 max-w-3xl font-body text-body-md leading-relaxed text-on-surface-variant">
                    {primaryTicket.description || 'No description was supplied with this ticket.'}
                  </p>
                </div>

                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-y border-line py-2.5 sm:grid-cols-4">
                  {[
                    ['Ticket', `INC-${shortId(primaryTicket.id, 6)}`],
                    ['Priority', titleCase(primaryTicket.priority)],
                    ['Status', titleCase(primaryTicket.status)],
                    ['Created', relativeTime(primaryTicket.created_at)],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="mono-label text-outline">{label}</dt>
                      <dd className="mt-0.5 font-mono text-[11px] font-medium text-on-surface">{value}</dd>
                    </div>
                  ))}
                </dl>

                <div className="ai-panel p-md">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <Icon name="neurology" size={16} className="text-ai-ink" filled />
                      <span className="font-mono text-label-sm font-bold uppercase tracking-[0.08em] text-ai-ink">
                        AI Copilot // Root-cause synthesis
                      </span>
                    </div>
                    {triage.phase === 'done' ? (
                      <Badge tone={triage.response.confidence === 'high' ? 'ok' : triage.response.confidence === 'medium' ? 'warn' : 'critical'}>
                        Confidence: {triage.response.confidence}
                      </Badge>
                    ) : (
                      <span className="font-mono text-label-sm text-ai-ink/70">Grounded on indexed context</span>
                    )}
                  </div>

                  {triage.phase === 'idle' || triageTicketId !== primaryTicket.id ? (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="max-w-xl font-body text-body-sm text-on-surface">
                        Run a grounded copilot triage for this ticket. The answer is generated from your
                        indexed documents, logs and tickets, and returns citations with confidence.
                      </p>
                      <Button
                        size="sm"
                        variant="ai"
                        icon="auto_awesome"
                        onClick={() => void runTriage(primaryTicket)}
                      >
                        Run triage
                      </Button>
                    </div>
                  ) : triage.phase === 'loading' ? (
                    <div className="mt-2 flex items-center gap-2 font-body text-body-sm text-ai-ink">
                      <Icon name="sync" size={16} className="animate-spin" />
                      Retrieving context and synthesizing an answer…
                    </div>
                  ) : triage.phase === 'error' ? (
                    <div className="mt-2 space-y-2">
                      <InlineError message={triage.message} onRetry={() => void runTriage(primaryTicket)} />
                    </div>
                  ) : (
                    <div className="mt-2 space-y-2.5">
                      <AiText text={triage.response.answer} />
                      <div className="flex flex-wrap items-center gap-2 border-t border-ai-border pt-2">
                        <span className="font-mono text-label-sm text-ai-ink">
                          {triage.response.sourceCount} cited chunks · {Math.round(triage.response.metrics.totalMs)}ms
                        </span>
                        <Button
                          size="sm"
                          variant="ai"
                          icon="open_in_new"
                          onClick={() =>
                            navigate(
                              `/copilot?q=${encodeURIComponent(`Explain the root cause of "${primaryTicket.title}" in detail`)}`
                            )
                          }
                        >
                          Open investigation
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <EmptyState
                icon="check_circle"
                title="No open incidents in this organization"
                description="Tickets ingested through the API appear here. Closed and resolved tickets remain available in the ticket workspace."
                action={
                  <Button variant="secondary" size="sm" icon="confirmation_number" onClick={() => navigate('/tickets')}>
                    Open tickets
                  </Button>
                }
              />
            )}
          </article>

          <Panel
            title="Recent ingestion"
            icon="receipt_long"
            meta={`${latestLogs.length} most recent`}
            flush
            actions={
              <Link to="/logs" className="flex items-center gap-1 font-label-lg text-label-lg font-semibold text-primary hover:underline">
                Logs Explorer <Icon name="arrow_forward" size={14} />
              </Link>
            }
          >
            {latestLogs.length === 0 ? (
              <EmptyState
                compact
                icon="terminal"
                title="No telemetry indexed"
                description="Ingest log lines through the Logs Explorer to populate this stream."
                action={
                  <Button size="sm" variant="secondary" icon="upload" onClick={() => navigate('/logs')}>
                    Ingest logs
                  </Button>
                }
              />
            ) : (
              <div className="divide-y divide-line">
                {latestLogs.map((log) => {
                  const service =
                    typeof log.metadata?.service === 'string' ? log.metadata.service : null;
                  return (
                    <button
                      key={log.id}
                      onClick={() => navigate(`/logs?log=${log.id}`)}
                      className="row-hover flex w-full items-start gap-2 px-md py-2 text-left"
                    >
                      <span className="mt-0.5 shrink-0 font-mono text-[11px] tabular text-outline">
                        {formatTime(log.timestamp)}
                      </span>
                      <Badge tone={levelTone(log.level)} className="shrink-0">
                        {log.level || 'info'}
                      </Badge>
                      {service ? (
                        <span className="hidden shrink-0 rounded bg-surface-container px-1.5 py-0.5 font-mono text-[10px] text-primary sm:inline">
                          {service}
                        </span>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate font-mono text-code-sm text-on-surface-variant">
                        {log.message}
                      </span>
                      <Icon name="chevron_right" size={14} className="mt-0.5 shrink-0 text-outline" />
                    </button>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel
            title="Recent linked tickets"
            icon="mark_email_unread"
            meta="Organization scoped"
            flush
            actions={
              <Link to="/tickets" className="flex items-center gap-1 font-label-lg text-label-lg font-semibold text-primary hover:underline">
                All tickets <Icon name="arrow_forward" size={14} />
              </Link>
            }
          >
            {latestTickets.length === 0 ? (
              <EmptyState
                compact
                icon="confirmation_number"
                title="No tickets ingested"
                description="Tickets appear here as soon as they are ingested for this organization."
                action={
                  <Button size="sm" variant="secondary" onClick={() => navigate('/tickets')}>
                    Ingest tickets
                  </Button>
                }
              />
            ) : (
              <div className="grid gap-px bg-line sm:grid-cols-2">
                {latestTickets.map((ticket) => (
                  <div key={ticket.id} className="flex flex-col justify-between gap-2 bg-surface p-md">
                    <div>
                      <div className="mb-1 flex flex-wrap items-center justify-between gap-1">
                        <span className="font-mono text-label-sm text-outline">
                          INC-{shortId(ticket.id, 6)} · {relativeTime(ticket.created_at)}
                        </span>
                        <Badge tone={priorityTone(ticket.priority)}>{titleCase(ticket.priority)}</Badge>
                      </div>
                      <h3 className="font-label-lg text-label-lg font-semibold text-on-surface">
                        {ticket.title}
                      </h3>
                      <p className="mt-0.5 line-clamp-2 font-body text-body-sm text-on-surface-variant">
                        {ticket.description || 'No description recorded.'}
                      </p>
                    </div>
                    <div className="flex items-center justify-between border-t border-line pt-2">
                      <Badge tone={statusTone(ticket.status)}>{titleCase(ticket.status)}</Badge>
                      <button
                        onClick={() =>
                          navigate(`/copilot?q=${encodeURIComponent(`Triage the ticket "${ticket.title}"`)}`)
                        }
                        className="flex items-center gap-1 font-mono text-label-sm font-semibold text-primary hover:underline"
                      >
                        Triage with LLM <Icon name="arrow_forward" size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <aside className="flex min-w-0 flex-col gap-gutter lg:col-span-4">
          <Panel title="pgvector engine" icon="hub" meta="Index health">
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-body text-body-sm text-on-surface-variant">Indexed chunks</span>
                <span className="font-mono text-code-sm font-semibold text-on-surface tabular">
                  {formatNumber(overview.documents.chunks)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="font-body text-body-sm text-on-surface-variant">Documents processed</span>
                <span className="font-mono text-code-sm font-semibold text-on-surface tabular">
                  {formatNumber(overview.documents.processed)} / {formatNumber(docTotal)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="font-body text-body-sm text-on-surface-variant">In pipeline</span>
                <span className="font-mono text-code-sm font-semibold text-warning-ink tabular">
                  {formatNumber(overview.documents.processing + overview.documents.pending)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="font-body text-body-sm text-on-surface-variant">Failed ingestion</span>
                <span className="font-mono text-code-sm font-semibold text-error tabular">
                  {formatNumber(overview.documents.failed)}
                </span>
              </div>
              <div className="pt-1">
                <div className="mb-1 flex items-center justify-between font-mono text-label-sm text-outline">
                  <span>Index coverage</span>
                  <span className="tabular">{docTotal === 0 ? '0%' : `${Math.round(docHealthy)}%`}</span>
                </div>
                <Progress value={overview.documents.processed} max={Math.max(docTotal, 1)} tone={overview.documents.failed > 0 ? 'warn' : 'primary'} />
              </div>
              <div className="flex items-center justify-between border-t border-line pt-2">
                <span className="font-mono text-label-sm text-outline">
                  Last ingestion {relativeTime(overview.documents.lastIngestedAt)}
                </span>
                <Link to="/documents" className="flex items-center gap-1 font-label-lg text-label-lg font-semibold text-primary hover:underline">
                  Knowledge <Icon name="arrow_forward" size={13} />
                </Link>
              </div>
            </div>
          </Panel>

          <div className="ai-panel p-md">
            <div className="flex items-center justify-between gap-2 border-b border-ai-border pb-2">
              <div className="flex items-center gap-1.5">
                <Icon name="smart_toy" size={17} className="text-ai-ink" filled />
                <h2 className="font-headline-sm text-headline-sm text-on-surface">Copilot investigations</h2>
              </div>
              <Badge tone="ai">Grounded</Badge>
            </div>
            <p className="mt-2 font-body text-body-sm text-on-surface-variant">
              Prompts that use this workspace’s indexed evidence. Each one calls the same RAG pipeline
              as the copilot console.
            </p>
            <div className="mt-2 space-y-1.5">
              {[
                'Summarize the most recent error logs and their likely cause.',
                'Which open tickets need immediate triage, and why?',
                'What runbooks cover database connection pool exhaustion?',
              ].map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => navigate(`/copilot?q=${encodeURIComponent(prompt)}`)}
                  className="group flex w-full items-start gap-2 rounded border border-ai-border bg-surface px-2.5 py-2 text-left transition-colors hover:bg-ai-surface"
                >
                  <Icon name="north_east" size={14} className="mt-0.5 text-ai-ink" />
                  <span className="flex-1 font-body text-body-sm text-on-surface">{prompt}</span>
                </button>
              ))}
            </div>
          </div>

          <Panel title="Knowledge ingest" icon="upload_file" meta="PDF · MD · TXT">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex w-full flex-col items-center justify-center gap-1.5 rounded border-2 border-dashed border-outline-variant bg-surface-low px-3 py-7 text-center transition-colors hover:border-primary disabled:opacity-60"
            >
              <Icon name={uploading ? 'sync' : 'note_add'} size={26} className={uploading ? 'animate-spin text-primary' : 'text-outline'} />
              <span className="font-label-lg text-label-lg font-semibold text-on-surface">
                {uploading ? 'Uploading & indexing…' : 'Drop a runbook or RCA spec'}
              </span>
              <span className="font-body text-body-sm text-on-surface-variant">
                Chunked, embedded and synced on upload
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              aria-label="Upload a knowledge document"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadDocument(file);
              }}
            />
            {uploadError ? <div className="mt-2"><InlineError message={uploadError} /></div> : null}
            {uploadSuccess ? (
              <div className="mt-2 flex items-center gap-1.5 rounded border border-success-line bg-success-surface px-2.5 py-1.5 font-body text-body-sm text-success-ink">
                <Icon name="check_circle" size={14} /> {uploadSuccess}
              </div>
            ) : null}
            <div className="mt-3 flex items-center justify-between border-t border-line pt-2 font-mono text-label-sm text-outline">
              <span className="truncate">
                {overview.documents.total} files · {formatNumber(overview.documents.chunks)} chunks
              </span>
              <Link to="/documents" className="font-semibold text-primary hover:underline">
                View all
              </Link>
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
