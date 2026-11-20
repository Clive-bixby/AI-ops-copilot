import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { useApiData, useInterval } from '../lib/hooks';
import {
  fileIcon,
  fileType,
  formatDateTime,
  formatNumber,
  relativeTime,
  shortId,
} from '../lib/format';
import type { DocumentDetail, DocumentSummary, Overview } from '../lib/types';
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  ErrorState,
  Icon,
  InlineError,
  PageHeader,
  Pagination,
  Panel,
} from '../components/ui';
import type { BadgeTone } from '../components/ui';

interface DocumentsData {
  documents: DocumentSummary[];
  overview: Overview | null;
}

const STATUS_OPTIONS = ['all', 'processed', 'processing', 'pending', 'failed'];

function statusTone(status: string): BadgeTone {
  if (status === 'processed') return 'ok';
  if (status === 'failed') return 'critical';
  if (status === 'processing' || status === 'pending') return 'warn';
  return 'neutral';
}

function statusLabel(status: string): string {
  if (status === 'processed') return 'Indexed';
  if (status === 'failed') return 'Failed';
  if (status === 'processing') return 'Processing';
  if (status === 'pending') return 'Queued';
  return status;
}

export function Documents() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const { data, loading, error, reload } = useApiData<DocumentsData>(async () => {
    const [documents, overview] = await Promise.all([
      api.documents.list(),
      api.insights.overview().catch(() => null),
    ]);
    return { documents, overview };
  }, []);

  const documents = data?.documents ?? [];
  const overview = data?.overview ?? null;

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [type, setType] = useState('all');
  const [page, setPage] = useState(1);
  const pageSize = 10;

  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('doc'));
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  // A 202 means the document is queued, not that it is already visible in the
  // list. Keep polling for a short grace period so the first queued row is
  // picked up without waiting for a manual refresh.
  const [pollAfterUpload, setPollAfterUpload] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const types = useMemo(
    () => Array.from(new Set(documents.map((document) => fileType(document.filename)))).sort(),
    [documents]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return documents.filter((document) => {
      if (status !== 'all' && document.processingStatus !== status) return false;
      if (type !== 'all' && fileType(document.filename) !== type) return false;
      if (!needle) return true;
      return `${document.filename} ${document.id}`.toLowerCase().includes(needle);
    });
  }, [documents, query, status, type]);

  useEffect(() => {
    setPage(1);
  }, [query, status, type]);

  const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);
  const hasProcessing = documents.some((document) =>
    ['processing', 'pending'].includes(document.processingStatus)
  );

  useEffect(() => {
    if (!pollAfterUpload) return;
    const timer = window.setTimeout(() => setPollAfterUpload(false), 30_000);
    return () => window.clearTimeout(timer);
  }, [pollAfterUpload]);

  useInterval(
    () => void reload(true),
    hasProcessing || uploading || pollAfterUpload ? 3000 : null
  );

  useEffect(() => {
    if (documents.length > 0 && !selectedId) setSelectedId(documents[0]?.id ?? null);
  }, [documents, selectedId]);

  useEffect(() => {
    const target = searchParams.get('doc');
    if (target) setSelectedId(target);
  }, [searchParams]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);

    api.documents
      .get(selectedId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setDetail(null);
          setDetailError(errorMessage(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId, data]);

  const resetFilters = () => {
    setQuery('');
    setStatus('all');
    setType('all');
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    setUploadSuccess(null);
    try {
      const result = await api.documents.upload(file);
      setPollAfterUpload(true);
      setUploadSuccess(`${result.filename} queued. Parsing, chunking and embedding run in the background.`);
      setSelectedId(result.id);
      await reload(true);
    } catch (caught) {
      setUploadError(errorMessage(caught));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const emptyButExisting = documents.length > 0 && filtered.length === 0;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <>
            <span className="eyebrow">Knowledge base</span>
            <span className="h-1 w-1 rounded-full bg-outline" />
            <span className="font-mono text-label-sm uppercase tracking-wider text-primary">
              Runbook &amp; post-mortem repository
            </span>
            {hasProcessing ? (
              <Badge tone="warn" pulse>
                ingestion active
              </Badge>
            ) : (
              <Badge tone="ok">pipeline idle</Badge>
            )}
          </>
        }
        title="Knowledge & Operational Docs"
        description="Upload runbooks, RFCs and post-mortems; the API parses, chunks and embeds them into pgvector so the copilot can cite them."
        actions={
          <>
            <Button variant="secondary" icon="refresh" onClick={() => void reload()} disabled={loading}>
              Refresh
            </Button>
            <Button icon="upload_file" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? 'Uploading…' : 'Upload document'}
            </Button>
          </>
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        aria-label="Upload document"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void uploadFile(file);
        }}
      />

      {error && !data ? (
        <ErrorState message={error} onRetry={() => void reload()} />
      ) : (
        <>
          <div className="panel grid grid-cols-2 divide-x divide-y divide-line overflow-hidden md:grid-cols-4 md:divide-y-0">
            {[
              {
                label: 'Total documents',
                value: formatNumber(overview?.documents.total ?? documents.length),
                hint: `${documents.filter((document) => document.processingStatus === 'processed').length} indexed`,
                icon: 'description',
              },
              {
                label: 'Embedded chunks',
                value: formatNumber(overview?.documents.chunks ?? 0),
                hint: 'pgvector cosine index',
                icon: 'hub',
              },
              {
                label: 'In pipeline',
                value: formatNumber(
                  overview
                    ? overview.documents.processing + overview.documents.pending
                    : documents.filter((document) => ['processing', 'pending'].includes(document.processingStatus)).length
                ),
                hint: 'Parsing or embedding',
                icon: 'pending_actions',
              },
              {
                label: 'Failed ingestion',
                value: formatNumber(
                  overview?.documents.failed ??
                    documents.filter((document) => document.processingStatus === 'failed').length
                ),
                hint: 'Inspect the document inspector for the error',
                icon: 'error',
              },
            ].map((stat) => (
              <div key={stat.label} className="flex flex-col justify-between gap-2 bg-surface p-md">
                <div className="flex items-start justify-between">
                  <span className="mono-label text-outline">{stat.label}</span>
                  <Icon name={stat.icon} size={16} className="text-outline" />
                </div>
                <span className="font-headline-md text-headline-md font-bold tabular text-on-surface">
                  {stat.value}
                </span>
                <span className="font-body text-body-sm text-on-surface-variant">{stat.hint}</span>
              </div>
            ))}
          </div>

          <section className="panel p-md">
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                const file = event.dataTransfer.files?.[0];
                if (file && !uploading) void uploadFile(file);
              }}
              className={clsx(
                'flex flex-col items-center justify-center gap-1 rounded border-2 border-dashed px-4 py-5 text-center transition-colors',
                dragActive ? 'border-primary bg-primary-fixed/30' : 'border-outline-variant bg-surface-low'
              )}
            >
              <Icon
                name={uploading ? 'sync' : 'cloud_upload'}
                size={24}
                className={uploading ? 'animate-spin text-primary' : 'text-outline'}
              />
              <div className="font-label-lg text-label-lg font-semibold text-on-surface">
                {uploading ? 'Uploading…' : 'Drop a runbook, RFC or post-mortem here'}
              </div>
              <div className="font-body text-body-sm text-on-surface-variant">
                PDF, TXT, MD, CSV, JSON or LOG · queued for background indexing
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-center">
              <div className="relative flex-1">
                <Icon name="search" size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter documents by name or id…"
                  aria-label="Filter documents"
                  className="input pl-9"
                />
              </div>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                aria-label="Filter by ingestion status"
                className="select w-[180px]"
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option === 'all' ? 'Status: all' : statusLabel(option)}
                  </option>
                ))}
              </select>
              <select
                value={type}
                onChange={(event) => setType(event.target.value)}
                aria-label="Filter by file type"
                className="select w-[150px]"
              >
                <option value="all">Type: all</option>
                {types.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              {emptyButExisting ? (
                <Button variant="ghost" size="sm" icon="filter_alt_off" onClick={resetFilters}>
                  Reset
                </Button>
              ) : null}
            </div>

            {uploadError ? <div className="mt-2"><InlineError message={uploadError} /></div> : null}
            {uploadSuccess ? (
              <div className="mt-2 flex items-center gap-1.5 rounded border border-success-line bg-success-surface px-3 py-2 font-body text-body-sm text-success-ink">
                <Icon name="check_circle" size={15} /> {uploadSuccess}
              </div>
            ) : null}
          </section>

          <div className="grid items-start gap-gutter-desktop xl:grid-cols-12">
            <div className="min-w-0 xl:col-span-8">
              <Panel title="Document corpus" icon="library_books" flush meta={`${filtered.length} of ${documents.length}`}>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-left">
                    <thead>
                      <tr className="border-b border-outline-variant bg-surface-low">
                        <th className="px-3 py-2 mono-label text-on-surface-variant">Document</th>
                        <th className="w-[70px] px-3 py-2 mono-label text-on-surface-variant">Type</th>
                        <th className="w-[84px] px-3 py-2 mono-label text-on-surface-variant">Chunks</th>
                        <th className="w-[130px] px-3 py-2 mono-label text-on-surface-variant">Status</th>
                        <th className="w-[130px] px-3 py-2 mono-label text-on-surface-variant">Ingested</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading && !data ? (
                        <tr>
                          <td colSpan={5} className="px-4 py-10 text-center font-body text-body-sm text-outline">
                            Loading knowledge corpus…
                          </td>
                        </tr>
                      ) : pageItems.length === 0 ? (
                        <tr>
                          <td colSpan={5}>
                            <EmptyState
                              icon="library_books"
                              title={documents.length === 0 ? 'No documents ingested' : 'No documents match these filters'}
                              description={
                                documents.length === 0
                                  ? 'Upload a runbook or post-mortem to build the retrieval corpus for this organization.'
                                  : 'Change the status, type or text filter to see more of the corpus.'
                              }
                              action={
                                documents.length === 0 ? (
                                  <Button size="sm" icon="upload_file" onClick={() => fileInputRef.current?.click()}>
                                    Upload document
                                  </Button>
                                ) : (
                                  <Button size="sm" variant="secondary" onClick={resetFilters}>
                                    Reset filters
                                  </Button>
                                )
                              }
                            />
                          </td>
                        </tr>
                      ) : (
                        pageItems.map((document) => {
                          const active = document.id === selectedId;
                          return (
                            <tr
                              key={document.id}
                              onClick={() => setSelectedId(document.id)}
                              className={clsx(
                                'cursor-pointer border-b border-line transition-colors',
                                active ? 'bg-primary-fixed/35' : 'hover:bg-surface-low'
                              )}
                            >
                              <td className="px-3 py-2.5">
                                <div className="flex items-center gap-2">
                                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-outline-variant bg-surface-low text-primary">
                                    <Icon name={fileIcon(document.filename)} size={17} />
                                  </span>
                                  <div className="min-w-0">
                                    <div className="truncate font-label-lg text-label-lg font-semibold text-on-surface">
                                      {document.filename}
                                    </div>
                                    <div className="font-mono text-[10px] text-outline">
                                      {shortId(document.id, 8)}
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-3 py-2.5">
                                <span className="rounded border border-outline-variant bg-surface-low px-1.5 py-0.5 font-mono text-[10px] text-on-surface-variant">
                                  {fileType(document.filename)}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 font-mono text-code-sm tabular text-on-surface-variant">
                                {document.chunkCount}
                              </td>
                              <td className="px-3 py-2.5">
                                <Badge tone={statusTone(document.processingStatus)}>
                                  {statusLabel(document.processingStatus)}
                                </Badge>
                              </td>
                              <td className="px-3 py-2.5 font-mono text-[11px] text-outline">
                                {relativeTime(document.createdAt)}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                <Pagination page={page} pageSize={pageSize} total={filtered.length} onPage={setPage} label="documents" />
              </Panel>
            </div>

            <div className="min-w-0 xl:col-span-4">
              <div className="sticky top-[72px]">
                {selectedId ? (
                  <div className="panel overflow-hidden">
                    <div className="flex items-start justify-between gap-2 border-b border-line bg-surface-low px-md py-2.5">
                      <div className="min-w-0">
                        <div className="eyebrow">Document inspector</div>
                        <div className="mt-0.5 truncate font-label-lg text-label-lg font-semibold text-on-surface">
                          {detail?.filename ?? documents.find((document) => document.id === selectedId)?.filename ?? 'Loading…'}
                        </div>
                      </div>
                      <CopyButton value={selectedId} label="ID" />
                    </div>

                    <div className="space-y-3 p-md">
                      {detailLoading && !detail ? (
                        <div className="flex items-center gap-2 py-4 font-body text-body-sm text-outline">
                          <Icon name="sync" size={16} className="animate-spin" /> Loading document detail…
                        </div>
                      ) : detailError ? (
                        <InlineError message={detailError} onRetry={() => setSelectedId(selectedId)} />
                      ) : detail ? (
                        <>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge tone={statusTone(detail.processingStatus)}>{statusLabel(detail.processingStatus)}</Badge>
                            <Badge tone="primary">{fileType(detail.filename)}</Badge>
                            <span className="font-mono text-label-sm text-outline">
                              {detail.chunkCount} chunks
                            </span>
                          </div>

                          {detail.processingError ? (
                            <div className="rounded border border-critical-line bg-critical-surface px-2.5 py-2 font-mono text-[11px] text-critical-ink">
                              {detail.processingError}
                            </div>
                          ) : null}

                          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-y border-line py-2">
                            {[
                              ['Created', formatDateTime(detail.createdAt)],
                              ['Processed', detail.processedAt ? formatDateTime(detail.processedAt) : '—'],
                              ['Document ID', shortId(detail.id, 12)],
                              ['Visibility', 'Organization'],
                            ].map(([label, value]) => (
                              <div key={label}>
                                <dt className="mono-label text-outline">{label}</dt>
                                <dd className="mt-0.5 break-words font-mono text-[11px] text-on-surface">{value}</dd>
                              </div>
                            ))}
                          </dl>

                          <div className="flex flex-wrap gap-1.5">
                            <Button
                              size="sm"
                              variant="ai"
                              icon="neurology"
                              onClick={() =>
                                navigate(
                                  `/copilot?q=${encodeURIComponent(
                                    `Summarize the operational guidance in the document "${detail.filename}" and when an on-call engineer should use it.`
                                  )}`
                                )
                              }
                            >
                              Ask Copilot
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              icon="search"
                              onClick={() => navigate(`/search?q=${encodeURIComponent(detail.filename)}`)}
                            >
                              Test retrieval
                            </Button>
                          </div>

                          <div className="border-t border-line pt-2">
                            <div className="mb-1.5 flex items-center justify-between">
                              <span className="mono-label text-outline">
                                Indexed chunks {detail.chunkCount > detail.chunks.length ? `(first ${detail.chunks.length})` : ''}
                              </span>
                              <span className="font-mono text-[10px] text-outline">cosine index</span>
                            </div>
                            {detail.chunks.length === 0 ? (
                              <p className="font-body text-body-sm text-outline">
                                No chunks are stored yet. If the document is still processing, this panel
                                refreshes automatically; if it failed, the error above explains why.
                              </p>
                            ) : (
                              <div className="max-h-[360px] space-y-1.5 overflow-y-auto pr-1">
                                {detail.chunks.map((chunk) => (
                                  <div key={chunk.id} className="rounded border border-outline-variant bg-surface-low p-2">
                                    <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-outline">
                                      <span>Chunk #{chunk.chunkIndex}</span>
                                      <span>
                                        {typeof chunk.metadata?.tokenCount === 'number'
                                          ? `${chunk.metadata.tokenCount} tok`
                                          : ''}
                                      </span>
                                    </div>
                                    <p className="line-clamp-3 font-mono text-[11px] leading-relaxed text-on-surface-variant">
                                      {chunk.preview}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          <p className="border-t border-line pt-2 font-body text-[11px] leading-relaxed text-outline">
                            Indexing runs in a background worker. This panel refreshes while the
                            document is queued or processing.
                          </p>
                        </>
                      ) : (
                        <EmptyState compact icon="description" title="Document not found" />
                      )}
                    </div>
                  </div>
                ) : (
                  <Panel title="Document inspector" icon="frame_inspect">
                    <EmptyState
                      compact
                      icon="touch_app"
                      title="Select a document"
                      description="Inspect ingestion status, processing errors and the chunks that were embedded for retrieval."
                    />
                  </Panel>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
