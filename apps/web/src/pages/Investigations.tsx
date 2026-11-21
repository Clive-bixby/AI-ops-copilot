import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useApiData, useDebouncedValue } from '../lib/hooks';
import { formatDateTime, relativeTime, shortId, titleCase } from '../lib/format';
import type {
  AnalysisHypothesis,
  EvidenceRelevance,
  Investigation,
  InvestigationAnalysis,
  InvestigationAnalysisResult,
  InvestigationDetail,
  InvestigationEvidenceItem,
  InvestigationList,
  InvestigationTimeline,
  TimelineCorrelation,
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
} from '../components/ui';
import type { BadgeTone } from '../components/ui';

const STATUSES = ['open', 'investigating', 'resolved', 'closed'] as const;
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

function investigationStatusTone(status: string | null | undefined): BadgeTone {
  if (status === 'open') return 'primary';
  if (status === 'investigating') return 'warn';
  if (status === 'resolved') return 'ok';
  return 'neutral';
}

function severityTone(severity: string | null | undefined): BadgeTone {
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'accent';
  if (severity === 'medium') return 'warn';
  return 'neutral';
}

/**
 * Evidence quality is assigned by deterministic rules. The tone only mirrors
 * that grade; it never upgrades it.
 */
function relevanceTone(relevance: EvidenceRelevance): BadgeTone {
  if (relevance === 'direct') return 'ok';
  if (relevance === 'historical') return 'primary';
  if (relevance === 'related') return 'warn';
  return 'neutral';
}

function hypothesisTone(status: AnalysisHypothesis['status']): BadgeTone {
  if (status === 'supported') return 'ok';
  if (status === 'unverified') return 'warn';
  return 'neutral';
}

function correlationLabel(value: TimelineCorrelation): string {
  return value.replace(/_/g, ' ');
}

function sourceLabel(sourceType: string): string {
  if (sourceType === 'log') return 'Log group';
  if (sourceType === 'ticket') return 'Ticket';
  return 'Document';
}

function EvidenceItem({ item }: { item: InvestigationEvidenceItem }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <article className="border-b border-line px-md py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral" icon={item.sourceType === 'log' ? 'terminal' : item.sourceType === 'ticket' ? 'confirmation_number' : 'description'}>
          {sourceLabel(item.sourceType)}
        </Badge>
        <Badge tone={relevanceTone(item.relevance)}>{titleCase(item.relevance)}</Badge>
        {item.origin === 'manual' ? <Badge tone="ai">Linked by hand</Badge> : null}
        <span className="ml-auto font-mono text-label-sm text-outline">
          {item.sourceCreatedAt ? formatDateTime(item.sourceCreatedAt) : 'no source timestamp'}
        </span>
      </div>

      <h3 className="mt-1.5 font-label-lg text-label-lg font-semibold text-on-surface">
        {item.sourceTitle}
      </h3>

      <p
        className={clsx(
          'mt-1 whitespace-pre-wrap font-mono text-code-sm leading-relaxed text-on-surface-variant',
          expanded ? '' : 'line-clamp-3'
        )}
      >
        {item.excerpt}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-label-sm text-outline">
        <span>match {item.matchType}</span>
        <span>
          {item.similarity === null ? 'similarity —' : `similarity ${item.similarity.toFixed(2)}`}
        </span>
        <span>added {relativeTime(item.createdAt)}</span>
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="ml-auto flex items-center gap-1 font-semibold text-primary hover:underline"
          aria-expanded={expanded}
        >
          <Icon name={expanded ? 'expand_less' : 'expand_more'} size={14} />
          {expanded ? 'Hide details' : 'Why is this here?'}
        </button>
      </div>

      {expanded ? (
        <dl className="mt-2 space-y-1.5 rounded border border-line bg-surface-low px-2.5 py-2">
          <div>
            <dt className="mono-label text-outline">Grading reason</dt>
            <dd className="mt-0.5 font-body text-body-sm text-on-surface">{item.inclusionReason}</dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <dt className="mono-label text-outline">Retrieved by</dt>
            <dd className="font-mono text-code-sm text-on-surface-variant">
              {item.retrievalQuery}
            </dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <dt className="mono-label text-outline">Source id</dt>
            <dd className="font-mono text-code-sm text-on-surface-variant">{item.sourceId}</dd>
            <CopyButton value={item.sourceId} label="Copy" />
          </div>
        </dl>
      ) : null}
    </article>
  );
}

function HypothesisCard({ hypothesis }: { hypothesis: AnalysisHypothesis }) {
  return (
    <div className="rounded border border-line bg-surface-low p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={hypothesisTone(hypothesis.status)}>{hypothesis.status}</Badge>
        <span className="font-mono text-label-sm text-outline">
          {hypothesis.statusSource === 'user' ? 'verdict by a person' : 'proposed by the model'}
        </span>
      </div>
      <p className="mt-1.5 font-body text-body-md font-medium text-on-surface">
        {hypothesis.statement}
      </p>
      <p className="mt-1 font-body text-body-sm text-on-surface-variant">{hypothesis.rationale}</p>
      {hypothesis.verificationSteps.length > 0 ? (
        <div className="mt-2">
          <div className="mono-label text-outline">How to verify</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 font-body text-body-sm text-on-surface-variant">
            {hypothesis.verificationSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {hypothesis.missingInformation.length > 0 ? (
        <div className="mt-2">
          <div className="mono-label text-outline">Missing information</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 font-body text-body-sm text-on-surface-variant">
            {hypothesis.missingInformation.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {hypothesis.status === 'unverified' ? (
        <p className="mt-2 border-t border-line pt-1.5 font-body text-[11px] text-outline">
          Unverified hypothesis, not a confirmed root cause.
        </p>
      ) : null}
    </div>
  );
}

function AnalysisSection({
  analysis,
  hypotheses,
}: {
  analysis: InvestigationAnalysis | null;
  hypotheses: AnalysisHypothesis[];
}) {
  if (!analysis) {
    return (
      <EmptyState
        compact
        icon="neurology"
        title="No analysis stored"
        description="This investigation has no analysis run yet. Analysis is started explicitly through the API and is never simulated here."
      />
    );
  }

  if (analysis.status === 'failed') {
    return (
      <InlineError
        message={
          analysis.failureReason ??
          'The last analysis run failed. It is recorded so it is not mistaken for a result.'
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={analysis.insufficientEvidence ? 'warn' : 'ok'}>
          {analysis.insufficientEvidence ? 'insufficient evidence' : 'analysis stored'}
        </Badge>
        <span className="font-mono text-label-sm text-outline">
          {analysis.provider} · {analysis.model} · {relativeTime(analysis.createdAt)}
        </span>
      </div>

      {analysis.summary ? (
        <p className="whitespace-pre-wrap font-body text-body-md leading-relaxed text-on-surface">
          {analysis.summary}
        </p>
      ) : null}

      {analysis.insufficientEvidence ? (
        <div className="rounded border border-warning-line bg-warning-surface px-3 py-2 font-body text-body-sm text-warning-ink">
          The model judged the evidence insufficient to explain this incident.
        </div>
      ) : null}

      {analysis.keyObservations.length > 0 ? (
        <div>
          <div className="mono-label text-outline">Key observations</div>
          <ul className="mt-1 list-disc space-y-1 pl-4 font-body text-body-sm text-on-surface-variant">
            {analysis.keyObservations.map((observation) => (
              <li key={observation}>{observation}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {analysis.nextSteps.length > 0 ? (
        <div>
          <div className="mono-label text-outline">Suggested next steps</div>
          <ol className="mt-1 list-decimal space-y-1 pl-4 font-body text-body-sm text-on-surface-variant">
            {analysis.nextSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}

      {analysis.missingInformation.length > 0 ? (
        <div>
          <div className="mono-label text-outline">Missing information</div>
          <ul className="mt-1 list-disc space-y-1 pl-4 font-body text-body-sm text-on-surface-variant">
            {analysis.missingInformation.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="border-t border-line pt-2">
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <span className="mono-label text-outline">Hypotheses</span>
          <span className="font-mono text-label-sm text-outline">
            not root causes unless verified
          </span>
        </div>
        {hypotheses.length === 0 ? (
          <p className="font-body text-body-sm text-outline">
            This analysis did not produce any hypotheses.
          </p>
        ) : (
          <div className="space-y-2">
            {hypotheses.map((hypothesis) => (
              <HypothesisCard key={hypothesis.id} hypothesis={hypothesis} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineSection({ timeline }: { timeline: InvestigationTimeline }) {
  if (timeline.events.length === 0) {
    return (
      <p className="px-md py-6 text-center font-body text-body-sm text-outline">
        No timeline events yet. Evidence and activity appear here as they are recorded.
      </p>
    );
  }

  return (
    <div className="max-h-[420px] overflow-y-auto">
      <ol className="divide-y divide-line">
        {timeline.events.map((event) => (
          <li key={event.id} className="flex gap-3 px-md py-2">
            <div className="w-[132px] shrink-0">
              <div className="font-mono text-label-sm text-on-surface">
                {formatDateTime(event.at)}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-outline">
                {event.atSourceTime ? 'source time' : 'recorded'}
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-label-lg text-label-lg text-on-surface">{event.title}</span>
                {event.relevance ? (
                  <Badge tone={relevanceTone(event.relevance)}>{titleCase(event.relevance)}</Badge>
                ) : null}
                {event.correlations.map((correlation) => (
                  <span
                    key={correlation}
                    className="rounded border border-outline-variant px-1 font-mono text-[10px] uppercase tracking-wider text-outline"
                  >
                    {correlationLabel(correlation)}
                  </span>
                ))}
              </div>
              {event.detail ? (
                <p className="mt-0.5 line-clamp-2 font-body text-body-sm text-on-surface-variant">
                  {event.detail}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {timeline.summary.clipped ? (
        <p className="border-t border-line px-md py-2 font-body text-body-sm text-outline">
          Older events were clipped to keep this timeline readable.
        </p>
      ) : null}
    </div>
  );
}

function InvestigationListPanel({
  investigations,
  selectedId,
  onSelect,
}: {
  investigations: Investigation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="divide-y divide-line">
      {investigations.map((investigation) => (
        <button
          key={investigation.id}
          onClick={() => onSelect(investigation.id)}
          className={clsx(
            'flex w-full flex-col gap-1 px-md py-3 text-left transition-colors',
            investigation.id === selectedId
              ? 'bg-primary-fixed/35'
              : 'bg-surface hover:bg-surface-low'
          )}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={investigationStatusTone(investigation.status)}>
              {investigation.status}
            </Badge>
            <Badge tone={severityTone(investigation.severity)}>{investigation.severity}</Badge>
            <span className="ml-auto font-mono text-label-sm text-outline">
              {relativeTime(investigation.createdAt)}
            </span>
          </div>
          <span className="font-label-lg text-label-lg font-semibold text-on-surface">
            {investigation.title}
          </span>
          <span className="font-mono text-label-sm text-outline">
            INV-{shortId(investigation.id, 6)}
            {investigation.service ? ` · ${investigation.service}` : ''}
          </span>
        </button>
      ))}
    </div>
  );
}

export function Investigations() {
  const listState = useApiData<InvestigationList>(() => api.investigations.list({ limit: 50 }), []);
  const investigations = listState.data?.investigations ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [severity, setSeverity] = useState('all');
  const debouncedQuery = useDebouncedValue(query, 180);

  useEffect(() => {
    if (investigations.length > 0 && !selectedId) {
      setSelectedId(investigations[0]?.id ?? null);
    }
  }, [investigations, selectedId]);

  const filtered = useMemo(() => {
    const needle = debouncedQuery.trim().toLowerCase();
    return investigations.filter((investigation) => {
      if (status !== 'all' && investigation.status !== status) return false;
      if (severity !== 'all' && investigation.severity !== severity) return false;
      if (!needle) return true;
      return [
        investigation.title,
        investigation.description,
        investigation.service,
        investigation.errorSignature,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [investigations, status, severity, debouncedQuery]);

  const bundle = useApiData<{
    detail: InvestigationDetail;
    timeline: InvestigationTimeline;
    analysis: InvestigationAnalysisResult;
  } | null>(async () => {
    if (!selectedId) return null;
    const [detail, timeline, analysis] = await Promise.all([
      api.investigations.get(selectedId),
      api.investigations.timeline(selectedId),
      api.investigations.analysis(selectedId),
    ]);
    return { detail, timeline, analysis };
  }, [selectedId]);

  const detail = bundle.data?.detail ?? null;
  const investigation = detail?.investigation ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <>
            <span className="eyebrow">Operations cockpit</span>
            <span className="h-1 w-1 rounded-full bg-outline" />
            <span className="font-mono text-label-sm uppercase tracking-wider text-primary">
              Incident intelligence
            </span>
            <Badge tone="neutral">{listState.data?.total ?? 0} recorded</Badge>
          </>
        }
        title="Investigations"
        description="Every investigation recorded for this organization, with its evidence set, timeline and the hypotheses the analysis produced."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon="refresh"
            onClick={() => void listState.reload()}
            disabled={listState.loading}
          >
            Refresh
          </Button>
        }
      />

      {listState.error && !listState.data ? (
        <ErrorState message={listState.error} onRetry={() => void listState.reload()} />
      ) : (
        <div className="grid items-start gap-gutter-desktop xl:grid-cols-12">
          <div className="min-w-0 xl:col-span-4">
            <Panel
              title="Investigations"
              icon="troubleshoot"
              meta={`${filtered.length} shown`}
              flush
            >
              <div className="space-y-2 border-b border-line p-md">
                <div className="relative">
                  <Icon
                    name="search"
                    size={16}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-outline"
                  />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Filter by title, service or signature…"
                    aria-label="Filter investigations"
                    className="input pl-8"
                  />
                </div>
                <div className="flex gap-1.5">
                  <select
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                    aria-label="Filter by status"
                    className="select flex-1"
                  >
                    <option value="all">Status: all</option>
                    {STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {titleCase(value)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={severity}
                    onChange={(event) => setSeverity(event.target.value)}
                    aria-label="Filter by severity"
                    className="select flex-1"
                  >
                    <option value="all">Severity: all</option>
                    {SEVERITIES.map((value) => (
                      <option key={value} value={value}>
                        {titleCase(value)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {listState.loading && !listState.data ? (
                <LoadingState label="Loading investigations…" />
              ) : investigations.length === 0 ? (
                <EmptyState
                  icon="troubleshoot"
                  title="No investigations recorded"
                  description="This view reads GET /investigations. Nothing has been created for this organization yet, so there is nothing to show."
                />
              ) : filtered.length === 0 ? (
                <EmptyState
                  compact
                  icon="filter_alt_off"
                  title="No investigations match these filters"
                  description="Widen the text, status or severity filters."
                  action={
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setQuery('');
                        setStatus('all');
                        setSeverity('all');
                      }}
                    >
                      Reset filters
                    </Button>
                  }
                />
              ) : (
                <InvestigationListPanel
                  investigations={filtered}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              )}
            </Panel>
          </div>

          <div className="min-w-0 space-y-4 xl:col-span-8">
            {bundle.error ? (
              <ErrorState message={bundle.error} onRetry={() => void bundle.reload()} />
            ) : !selectedId ? (
              <Panel title="Investigation" icon="frame_inspect">
                <EmptyState
                  compact
                  icon="touch_app"
                  title="Select an investigation"
                  description="Choose an investigation to inspect its evidence, timeline and analysis."
                />
              </Panel>
            ) : bundle.loading && !bundle.data ? (
              <Panel title="Investigation" icon="frame_inspect">
                <LoadingState label="Loading investigation…" />
              </Panel>
            ) : investigation && detail ? (
              <>
                <Panel
                  title={investigation.title}
                  icon="troubleshoot"
                  meta={`INV-${shortId(investigation.id, 8)}`}
                  actions={<CopyButton value={investigation.id} label="ID" />}
                >
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={investigationStatusTone(investigation.status)}>
                        {investigation.status}
                      </Badge>
                      <Badge tone={severityTone(investigation.severity)}>
                        {investigation.severity}
                      </Badge>
                      {investigation.service ? (
                        <Badge tone="neutral" icon="layers">
                          {investigation.service}
                        </Badge>
                      ) : null}
                      {investigation.windowStart && investigation.windowEnd ? (
                        <Badge tone="primary" icon="schedule">
                          window {formatDateTime(investigation.windowStart)} →{' '}
                          {formatDateTime(investigation.windowEnd)}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">no time window</Badge>
                      )}
                    </div>

                    <p className="whitespace-pre-wrap font-body text-body-md leading-relaxed text-on-surface-variant">
                      {investigation.description}
                    </p>

                    {investigation.errorSignature ? (
                      <div className="rounded border border-line bg-surface-low px-2.5 py-2">
                        <div className="mono-label text-outline">Error signature</div>
                        <code className="mt-0.5 block font-mono text-code-sm text-on-surface">
                          {investigation.errorSignature}
                        </code>
                      </div>
                    ) : null}

                    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-line pt-2 md:grid-cols-4">
                      {[
                        ['Created', formatDateTime(investigation.createdAt)],
                        ['Updated', relativeTime(investigation.updatedAt)],
                        ['Created by', investigation.createdByEmail ?? 'unknown'],
                        [
                          'Sources searched',
                          investigation.sourceTypes === null
                            ? 'all types'
                            : investigation.sourceTypes.join(', '),
                        ],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <dt className="mono-label text-outline">{label}</dt>
                          <dd className="mt-0.5 truncate font-mono text-[11px] text-on-surface">
                            {value}
                          </dd>
                        </div>
                      ))}
                    </dl>

                    {investigation.resolutionSummary ? (
                      <div className="rounded border border-success-line bg-success-surface px-2.5 py-2">
                        <div className="mono-label text-success-ink">Resolution summary</div>
                        <p className="mt-0.5 whitespace-pre-wrap font-body text-body-sm text-success-ink">
                          {investigation.resolutionSummary}
                        </p>
                      </div>
                    ) : null}
                  </div>
                </Panel>

                <Panel
                  title="Evidence"
                  icon="inventory_2"
                  meta={`${detail.evidence.length} item(s)`}
                  flush
                >
                  <div className="flex flex-wrap items-center gap-2 border-b border-line px-md py-2 font-mono text-label-sm text-outline">
                    <span>
                      {detail.evidence.filter((item) => item.origin === 'manual').length} linked by
                      hand
                    </span>
                    <span>·</span>
                    <span>
                      {detail.evidence.filter((item) => item.origin === 'retrieval').length}{' '}
                      collected
                    </span>
                    <span className="ml-auto">weak keyword matches are withheld from collection</span>
                  </div>
                  {detail.evidence.length === 0 ? (
                    <EmptyState
                      compact
                      icon="inventory_2"
                      title="No evidence collected"
                      description="Collection stores direct, historical and related evidence. If nothing qualified, the investigation stays legitimately empty rather than showing weak matches."
                    />
                  ) : (
                    <div>
                      {detail.evidence.map((item) => (
                        <EvidenceItem key={item.id} item={item} />
                      ))}
                    </div>
                  )}
                </Panel>

                <Panel
                  title="Timeline"
                  icon="timeline"
                  meta={
                    bundle.data
                      ? `${bundle.data.timeline.summary.total} event(s)`
                      : undefined
                  }
                  flush
                >
                  {bundle.data ? (
                    <TimelineSection timeline={bundle.data.timeline} />
                  ) : (
                    <LoadingState label="Loading timeline…" />
                  )}
                </Panel>

                <Panel title="Analysis & hypotheses" icon="neurology">
                  {bundle.data ? (
                    <AnalysisSection
                      analysis={bundle.data.analysis.analysis}
                      hypotheses={bundle.data.analysis.hypotheses}
                    />
                  ) : (
                    <LoadingState label="Loading analysis…" />
                  )}
                </Panel>
              </>
            ) : (
              <Panel title="Investigation" icon="frame_inspect">
                <EmptyState
                  compact
                  icon="search_off"
                  title="Investigation not available"
                  description="The API did not return this investigation. It may have been removed, or it belongs to another organization."
                />
              </Panel>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
