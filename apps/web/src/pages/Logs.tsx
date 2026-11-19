import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { useApiData, useDebouncedValue } from '../lib/hooks';
import {
  csvCell,
  downloadText,
  formatDateTime,
  formatNumber,
  formatTime,
  relativeTime,
  serializeMetadata,
  shortId,
} from '../lib/format';
import type { LogEntry } from '../lib/types';
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
  levelTone,
} from '../components/ui';

const LEVELS = ['all', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const RANGES = [
  { id: 'all', label: 'All loaded', ms: null },
  { id: '15m', label: 'Last 15 minutes', ms: 15 * 60_000 },
  { id: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
] as const;

type RangeId = (typeof RANGES)[number]['id'];

function serviceOf(log: LogEntry): string | null {
  const service = log.metadata?.service;
  if (typeof service === 'string' && service.trim()) return service;
  const app = log.metadata?.app;
  if (typeof app === 'string' && app.trim()) return app;
  return null;
}

export function Logs() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data, loading, error, reload } = useApiData<LogEntry[]>(() => api.logs.list(), []);
  const logs = data ?? [];

  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('all');
  const [range, setRange] = useState<RangeId>('all');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('log'));
  const debouncedQuery = useDebouncedValue(query, 180);
  const pageSize = 15;

  const [ingestOpen, setIngestOpen] = useState(false);
  const [ingestText, setIngestText] = useState('');
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestSuccess, setIngestSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (logs.length > 0 && !selectedId) setSelectedId(logs[0]?.id ?? null);
  }, [logs, selectedId]);

  useEffect(() => {
    const target = searchParams.get('log');
    if (target) setSelectedId(target);
  }, [searchParams]);

  const cutoff = RANGES.find((item) => item.id === range)?.ms ?? null;

  const filtered = useMemo(() => {
    const needle = debouncedQuery.trim().toLowerCase();
    const cutoffTime = cutoff ? Date.now() - cutoff : null;

    return logs.filter((log) => {
      if (level !== 'all' && (log.level || '').toLowerCase() !== level) return false;

      if (cutoffTime) {
        const time = new Date(log.timestamp).getTime();
        if (!Number.isFinite(time) || time < cutoffTime) return false;
      }

      if (!needle) return true;

      const haystack = [
        log.message,
        log.level,
        serviceOf(log),
        JSON.stringify(log.metadata ?? {}),
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(needle);
    });
  }, [logs, level, debouncedQuery, cutoff]);

  useEffect(() => {
    setPage(1);
  }, [level, debouncedQuery, cutoff]);

  const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);
  const selected = logs.find((log) => log.id === selectedId) ?? null;

  const levelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const log of logs) {
      const key = (log.level || 'info').toLowerCase();
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [logs]);

  const buckets = useMemo(() => {
    if (filtered.length === 0) return [];
    const times = filtered
      .map((log) => new Date(log.timestamp).getTime())
      .filter((time) => Number.isFinite(time));
    if (times.length === 0) return [];

    const min = Math.min(...times);
    const max = Math.max(...times);
    const span = Math.max(max - min, 60_000);
    const count = 32;
    const size = span / count;
    const series = Array.from({ length: count }, (_, index) => ({
      start: min + index * size,
      total: 0,
      errors: 0,
    }));

    const points = filtered
      .map((log) => ({
        time: new Date(log.timestamp).getTime(),
        isError: ['error', 'fatal'].includes((log.level || '').toLowerCase()),
      }))
      .filter((point) => Number.isFinite(point.time));

    for (const point of points) {
      const index = Math.min(count - 1, Math.max(0, Math.floor((point.time - min) / size)));
      const bucket = series[index];
      if (!bucket) continue;
      bucket.total += 1;
      if (point.isError) bucket.errors += 1;
    }

    return series;
  }, [filtered]);

  const bucketMax = Math.max(1, ...buckets.map((bucket) => bucket.total));

  const resetFilters = () => {
    setQuery('');
    setLevel('all');
    setRange('all');
    setPage(1);
  };

  const exportCsv = () => {
    const header = ['timestamp', 'level', 'service', 'message', 'id'].map(csvCell).join(',');
    const rows = filtered.map((log) =>
      [log.timestamp, log.level, serviceOf(log) ?? '', log.message, log.id].map(csvCell).join(',')
    );
    downloadText(
      `opspilot-logs-${new Date().toISOString().slice(0, 10)}.csv`,
      [header, ...rows].join('\n'),
      'text/csv'
    );
  };

  const submitIngest = async () => {
    setIngestError(null);
    setIngestSuccess(null);
    const trimmed = ingestText.trim();
    if (!trimmed) {
      setIngestError('Enter at least one log line or a JSON payload.');
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      payload = { logs: trimmed.split('\n').map((line) => line.trim()).filter(Boolean) };
    }

    const entries = Array.isArray(payload)
      ? payload
      : (payload as { logs?: unknown[] })?.logs;
    if (Array.isArray(entries) && entries.length === 0) {
      setIngestError('No log entries found.');
      return;
    }

    setIngesting(true);
    try {
      const result = await api.logs.ingest(payload);
      setIngestText('');
      setIngestSuccess(`Ingested ${result.count} log ${result.count === 1 ? 'entry' : 'entries'}.`);
      await reload(true);
    } catch (caught) {
      setIngestError(errorMessage(caught));
    } finally {
      setIngesting(false);
    }
  };

  const loadFile = async (file: File) => {
    try {
      setIngestText(await file.text());
      setIngestError(null);
    } catch {
      setIngestError('Could not read that file.');
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <>
            <span className="eyebrow">Telemetry engine</span>
            <span className="h-1 w-1 rounded-full bg-outline" />
            <span className="font-mono text-label-sm uppercase tracking-wider text-primary">
              Organization log buffer
            </span>
            <span className="hidden h-1 w-1 rounded-full bg-outline sm:inline" />
            <span className="hidden font-mono text-label-sm uppercase tracking-wider text-outline sm:inline">
              API limit: latest 100 records
            </span>
          </>
        }
        title="Live Event Stream"
        description="Inspect, filter and export the log entries ingested for this organization. Structured metadata is preserved exactly as the ingestion parser stored it."
        actions={
          <>
            <Button variant="secondary" icon="download" onClick={exportCsv} disabled={filtered.length === 0}>
              Export CSV
            </Button>
            <Button icon="upload" onClick={() => setIngestOpen(true)}>
              Ingest logs
            </Button>
          </>
        }
      />

      {error && !data ? (
        <ErrorState message={error} onRetry={() => void reload()} />
      ) : (
        <>
          <section className="panel p-md">
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <div className="relative flex-1">
                <Icon name="search" size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder='Filter by message, service, level or metadata — e.g. "pool timeout"'
                  aria-label="Filter logs"
                  className="input h-10 pl-9 font-mono text-code-sm"
                />
                {query ? (
                  <button
                    onClick={() => setQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-outline hover:bg-surface-container hover:text-on-surface"
                    aria-label="Clear filter"
                  >
                    <Icon name="close" size={15} />
                  </button>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={range}
                  onChange={(event) => setRange(event.target.value as RangeId)}
                  aria-label="Time range"
                  className="select h-10 min-w-[160px]"
                >
                  {RANGES.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <Button variant="secondary" icon="refresh" onClick={() => void reload()} disabled={loading}>
                  Refresh
                </Button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {LEVELS.map((entry) => {
                const active = level === entry;
                const count = entry === 'all' ? logs.length : levelCounts[entry] ?? 0;
                return (
                  <button
                    key={entry}
                    onClick={() => setLevel(entry)}
                    className={clsx(
                      'flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-label-sm uppercase tracking-wider transition-colors',
                      active
                        ? 'border-primary/30 bg-primary-fixed text-primary'
                        : 'border-outline-variant bg-surface-low text-on-surface-variant hover:text-on-surface'
                    )}
                  >
                    {entry === 'all' ? 'All levels' : entry}
                    <span className="tabular text-[10px] opacity-70">{count}</span>
                  </button>
                );
              })}
              <span className="ml-auto flex items-center gap-2 font-mono text-label-sm text-outline">
                <span className="tabular">
                  Loaded {formatNumber(logs.length)} · matched {formatNumber(filtered.length)}
                </span>
                {query || level !== 'all' || range !== 'all' ? (
                  <button onClick={resetFilters} className="flex items-center gap-1 text-primary hover:underline">
                    <Icon name="filter_alt_off" size={13} /> Reset
                  </button>
                ) : null}
              </span>
            </div>
          </section>

          <Panel
            title="Volume & anomaly distribution"
            icon="bar_chart"
            meta={filtered.length > 0 ? `${filtered.length} matching records` : 'No matching records'}
            actions={
              <div className="flex items-center gap-1.5 font-mono text-label-sm text-outline">
                <span className="h-2 w-2 rounded-sm bg-primary/40" /> volume
                <span className="ml-2 h-2 w-2 rounded-sm bg-error" /> errors
              </div>
            }
          >
            {loading && !data ? (
              <div className="flex h-24 items-center justify-center font-body text-body-sm text-outline">
                Loading telemetry…
              </div>
            ) : buckets.length === 0 ? (
              <div className="flex h-24 items-center justify-center font-body text-body-sm text-outline">
                No log volume matches the current filters.
              </div>
            ) : (
              <>
                <div className="flex h-24 items-end gap-[2px] border-b border-line pb-1">
                  {buckets.map((bucket, index) => {
                    const height = Math.max(3, Math.round((bucket.total / bucketMax) * 100));
                    const errorHeight = bucket.total > 0 ? (bucket.errors / bucket.total) * 100 : 0;
                    return (
                      <div
                        key={index}
                        className="group relative flex-1"
                        style={{ height: `${height}%` }}
                        title={`${formatTime(new Date(bucket.start).toISOString())} · ${bucket.total} events · ${bucket.errors} errors`}
                      >
                        <div className="absolute inset-0 rounded-sm bg-primary/35 transition-colors group-hover:bg-primary/60" />
                        {bucket.errors > 0 ? (
                          <div
                            className="absolute inset-x-0 bottom-0 rounded-sm bg-error"
                            style={{ height: `${errorHeight}%` }}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <div className="mt-1 flex justify-between font-mono text-[10px] text-outline">
                  <span>{formatTime(new Date(buckets[0]?.start ?? Date.now()).toISOString())}</span>
                  <span>{formatTime(new Date(buckets[buckets.length - 1]?.start ?? Date.now()).toISOString())}</span>
                </div>
              </>
            )}
          </Panel>

          <div className="grid items-start gap-gutter-desktop xl:grid-cols-12">
            <div className="min-w-0 xl:col-span-8">
              <Panel title="Live event stream" icon="terminal" flush>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] table-fixed text-left">
                    <thead>
                      <tr className="border-b border-outline-variant bg-surface-low">
                        <th className="w-[104px] px-3 py-2 mono-label text-on-surface-variant">Time</th>
                        <th className="w-[86px] px-3 py-2 mono-label text-on-surface-variant">Level</th>
                        <th className="w-[150px] px-3 py-2 mono-label text-on-surface-variant">Service</th>
                        <th className="px-3 py-2 mono-label text-on-surface-variant">Message</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono text-code-sm">
                      {loading && !data ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-10 text-center font-body text-body-sm text-outline">
                            Streaming latest records…
                          </td>
                        </tr>
                      ) : pageItems.length === 0 ? (
                        <tr>
                          <td colSpan={4}>
                            <EmptyState
                              compact
                              icon="search_off"
                              title="No logs match these filters"
                              description="Adjust the level, time range or text filter — or ingest a new batch."
                              action={
                                <Button size="sm" variant="secondary" onClick={resetFilters}>
                                  Reset filters
                                </Button>
                              }
                            />
                          </td>
                        </tr>
                      ) : (
                        pageItems.map((log) => {
                          const active = log.id === selectedId;
                          const service = serviceOf(log);
                          return (
                            <tr
                              key={log.id}
                              onClick={() => setSelectedId(log.id)}
                              className={clsx(
                                'cursor-pointer border-b border-line/70 transition-colors',
                                active ? 'bg-primary-fixed/40' : 'hover:bg-surface-low'
                              )}
                            >
                              <td className="px-3 py-2 align-top text-[11px] tabular text-outline">
                                {formatTime(log.timestamp)}
                              </td>
                              <td className="px-3 py-2 align-top">
                                <Badge tone={levelTone(log.level)}>{log.level || 'info'}</Badge>
                              </td>
                              <td className="truncate px-3 py-2 align-top text-primary">
                                {service ?? '—'}
                              </td>
                              <td className="truncate px-3 py-2 align-top text-on-surface-variant">
                                {log.message}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                <Pagination page={page} pageSize={pageSize} total={filtered.length} onPage={setPage} label="events" />
              </Panel>
            </div>

            <div className="min-w-0 xl:col-span-4">
              <div className="sticky top-[72px]">
                {selected ? (
                  <div className="panel overflow-hidden">
                    <div className="flex items-start justify-between gap-2 border-b border-line bg-surface-low px-md py-2.5">
                      <div className="min-w-0">
                        <div className="eyebrow">Inspect log frame</div>
                        <div className="mt-0.5 flex items-center gap-2">
                          <h2 className="truncate font-mono text-code-md font-semibold text-on-surface">
                            {shortId(selected.id, 12)}
                          </h2>
                          <CopyButton value={selected.id} label="ID" />
                        </div>
                      </div>
                      <a
                        href="#log-attributes"
                        className="rounded p-1 text-outline hover:text-on-surface"
                        aria-label="Jump to attributes"
                      >
                        <Icon name="south" size={16} />
                      </a>
                    </div>

                    <div className="space-y-3 p-md">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={levelTone(selected.level)}>{selected.level || 'info'}</Badge>
                        {serviceOf(selected) ? <Badge tone="primary">{serviceOf(selected)}</Badge> : null}
                        <span className="font-mono text-label-sm text-outline">
                          {relativeTime(selected.timestamp)}
                        </span>
                      </div>

                      <div className="rounded border border-outline-variant bg-surface-low p-2.5 font-mono text-code-sm leading-relaxed text-on-surface break-words">
                        {selected.message}
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          size="sm"
                          variant="ai"
                          icon="neurology"
                          onClick={() =>
                            navigate(
                              `/copilot?q=${encodeURIComponent(
                                `Analyze this log entry and its operational context: [${selected.level}] ${selected.message}`
                              )}`
                            )
                          }
                        >
                          Analyze with Copilot
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon="search"
                          onClick={() =>
                            navigate(`/search?q=${encodeURIComponent(selected.message.slice(0, 240))}`)
                          }
                        >
                          Related knowledge
                        </Button>
                      </div>

                      <div id="log-attributes" className="border-t border-line pt-2">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="mono-label text-outline">Structured attributes</span>
                          <CopyButton value={JSON.stringify(selected.metadata ?? {}, null, 2)} label="JSON" />
                        </div>
                        {selected.metadata && Object.keys(selected.metadata).length > 0 ? (
                          <dl className="divide-y divide-line rounded border border-outline-variant">
                            {Object.entries(selected.metadata).map(([key, value]) => (
                              <div key={key} className="grid grid-cols-[120px_1fr] gap-2 px-2 py-1.5">
                                <dt className="truncate font-mono text-[10px] uppercase tracking-wider text-outline">
                                  {key}
                                </dt>
                                <dd className="break-words font-mono text-[11px] text-on-surface">
                                  {typeof value === 'string' ? value : JSON.stringify(value)}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : (
                          <p className="font-body text-body-sm text-outline">
                            No structured metadata was supplied for this entry.
                          </p>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-2 border-t border-line pt-2 font-mono text-[11px]">
                        <div>
                          <div className="mono-label text-outline">Timestamp</div>
                          <div className="mt-0.5 text-on-surface">{formatDateTime(selected.timestamp)}</div>
                        </div>
                        <div>
                          <div className="mono-label text-outline">Recorded</div>
                          <div className="mt-0.5 text-on-surface">{formatDateTime(selected.created_at)}</div>
                        </div>
                      </div>

                      <details className="rounded border border-outline-variant bg-surface-low">
                        <summary className="cursor-pointer px-2.5 py-2 font-mono text-label-sm uppercase tracking-wider text-on-surface-variant">
                          Raw record
                        </summary>
                        <pre className="max-h-52 overflow-auto border-t border-line p-2.5 font-mono text-[10px] leading-relaxed text-on-surface-variant">
                          {serializeMetadata(selected as unknown as Record<string, unknown>)}
                        </pre>
                      </details>
                    </div>
                  </div>
                ) : (
                  <Panel title="Inspect log frame" icon="frame_inspect">
                    <EmptyState
                      compact
                      icon="touch_app"
                      title="Select a log entry"
                      description="Choose a row in the stream to inspect its structured attributes and correlate it with the copilot."
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
        title="Ingest log telemetry"
        description="POST /logs/ingest accepts a JSON array, a { logs: [...] } envelope, or one log per line. Levels map to debug, info, warn, error and fatal."
        footer={
          <>
            <Button variant="ghost" onClick={() => setIngestOpen(false)}>
              Close
            </Button>
            <Button icon="upload" onClick={() => void submitIngest()} disabled={ingesting}>
              {ingesting ? 'Ingesting…' : 'Ingest logs'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Payload">
            <textarea
              value={ingestText}
              onChange={(event) => setIngestText(event.target.value)}
              placeholder={'{"level":"error","message":"PoolAcquisitionTimeout","metadata":{"service":"checkout-api"}}'}
              className="input min-h-[200px] font-mono text-code-sm"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.csv,.log,.txt"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void loadFile(file);
                event.target.value = '';
              }}
            />
            <button className={buttonClass('secondary', 'sm')} onClick={() => fileInputRef.current?.click()}>
              <Icon name="folder_open" size={15} /> Load a .log or .json file
            </button>
            <span className="font-body text-body-sm text-outline">
              Files are read in the browser; nothing is stored locally.
            </span>
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
