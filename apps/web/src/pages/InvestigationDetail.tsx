import { useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { formatDateTime, relativeTime, shortId, titleCase } from '../lib/format';
import { useApiData } from '../lib/hooks';
import {
  investigationStatusTone,
  ownerLabel,
  severityTone,
} from '../lib/investigation';
import type {
  ActionItemSuggestion,
  CreateInvestigationInput,
  EvidenceCollectionSummary,
  Investigation,
  InvestigationDetail,
  UpdateInvestigationInput,
} from '../lib/types';
import {
  Badge,
  Button,
  ErrorState,
  Icon,
  InlineError,
  LoadingState,
  Modal,
  PageHeader,
  Panel,
  Tabs,
} from '../components/ui';
import { InvestigationForm } from '../components/investigations/InvestigationForm';
import { StatusControls } from '../components/investigations/StatusControls';
import { EvidencePanel } from '../components/investigations/EvidencePanel';
import { AnalysisPanel } from '../components/investigations/AnalysisPanel';
import { TimelinePanel } from '../components/investigations/TimelinePanel';
import { DiscussionPanel } from '../components/investigations/DiscussionPanel';
import { ActionItemPanel } from '../components/investigations/ActionItemPanel';

type TabID =
  | 'overview'
  | 'evidence'
  | 'analysis'
  | 'actions'
  | 'timeline'
  | 'discussion';

const ACTIVITY_LABELS: Record<string, string> = {
  created: 'Created',
  note: 'Note',
  comment: 'Comment',
  status_change: 'Status changed',
  severity_change: 'Severity changed',
  owner_change: 'Owner changed',
  evidence_added: 'Evidence added',
  evidence_removed: 'Evidence unlinked',
  hypothesis_created: 'Hypothesis recorded',
  hypothesis_status: 'Hypothesis verdict',
  analysis_started: 'Analysis started',
  analysis_succeeded: 'Analysis stored',
  analysis_failed: 'Analysis failed',
  follow_up: 'Follow-up question',
};

function activityLabel(type: string): string {
  return ACTIVITY_LABELS[type] ?? titleCase(type);
}

function readCount(metadata: Record<string, unknown> | null, key: string): number {
  const value = metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The last collection summary is persisted in the `evidence_added` activity
 * metadata, so it survives a reload instead of living only in the response that
 * triggered it.
 */
function lastCollection(
  activity: InvestigationDetail['activity']
): EvidenceCollectionSummary | null {
  const entry = activity.find((item) => item.type === 'evidence_added');
  if (!entry) return null;

  const metadata = entry.metadata;
  const warnings = Array.isArray(metadata?.warnings)
    ? metadata.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  const queries = Array.isArray(metadata?.queries)
    ? metadata.queries.filter((query): query is string => typeof query === 'string')
    : [];

  return {
    failed: false,
    queries,
    added: readCount(metadata, 'added'),
    existing: readCount(metadata, 'existing'),
    filteredOut: readCount(metadata, 'filteredOut'),
    withheld: readCount(metadata, 'withheld'),
    warnings,
  };
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="mono-label text-outline">{label}</dt>
      <dd className="mt-0.5 break-words font-body text-body-md text-on-surface">
        {children}
      </dd>
    </div>
  );
}

function ActivityFeed({ activity }: { activity: InvestigationDetail['activity'] }) {
  if (activity.length === 0) {
    return (
      <p className="px-md py-6 text-center font-body text-body-sm text-outline">
        No activity recorded yet.
      </p>
    );
  }

  return (
    <ol className="max-h-[420px] divide-y divide-line overflow-y-auto">
      {activity.map((entry) => (
        <li key={entry.id} className="px-md py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={entry.type === 'owner_change' ? 'accent' : 'neutral'}>
              {activityLabel(entry.type)}
            </Badge>
            <span className="font-mono text-label-sm text-outline">
              {entry.actorEmail ?? 'system'}
            </span>
            <span
              className="ml-auto font-mono text-label-sm text-outline"
              title={formatDateTime(entry.createdAt)}
            >
              {relativeTime(entry.createdAt)}
            </span>
          </div>
          {entry.body ? (
            <p className="mt-0.5 whitespace-pre-wrap font-body text-body-sm text-on-surface-variant">
              {entry.body}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function InvestigationDetailPage() {
  const navigate = useNavigate();
  const { id = '' } = useParams();

  const [tab, setTab] = useState<TabID>('overview');
  const [collection, setCollection] = useState<EvidenceCollectionSummary | null>(null);
  const [draftState, setDraftState] = useState<{
    investigationId: string;
    draft: ActionItemSuggestion | null;
  }>({ investigationId: id, draft: null });

  const detailState = useApiData(() => api.investigations.get(id), [id]);
  const timelineState = useApiData(() => api.investigations.timeline(id), [id]);
  const analysisState = useApiData(() => api.investigations.analysis(id), [id]);
  const actionItemsState = useApiData(() => api.actionItems.list(id), [id]);
  const membersState = useApiData(() => api.organization.members(), []);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const detail = detailState.data;
  const investigation: Investigation | null = detail?.investigation ?? null;

  // The draft belongs to one investigation. Keeping its id beside it means
  // opening another investigation starts empty without an effect to reset it.
  const actionDraft = draftState.investigationId === id ? draftState.draft : null;
  const setActionDraft = (draft: ActionItemSuggestion | null) =>
    setDraftState({ investigationId: id, draft });

  const refreshAll = async () => {
    await Promise.all([
      detailState.reload(true),
      timelineState.reload(true),
      analysisState.reload(true),
      actionItemsState.reload(true),
    ]);
  };

  const refreshAfterEvidence = async () => {
    const fresh = await detailState.reload(true);
    if (fresh) {
      setCollection(lastCollection(fresh.activity));
    }
    await timelineState.reload(true);
  };

  const saveEdit = async (payload: CreateInvestigationInput | UpdateInvestigationInput) => {
    if (!investigation) return;

    setSaving(true);
    setEditError(null);

    try {
      const result = await api.investigations.update(
        investigation.id,
        payload as UpdateInvestigationInput
      );
      setEditing(false);
      detailState.setData(() => result);
      await refreshAll();
    } catch (error) {
      setEditError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  if (detailState.loading && !detail) {
    return <LoadingState label="Loading investigation…" />;
  }

  if (detailState.error && !detail) {
    return (
      <div className="space-y-4">
        <Button variant="secondary" size="sm" icon="arrow_back" onClick={() => navigate('/investigations')}>
          Back to investigations
        </Button>
        <ErrorState
          title="Could not load this investigation"
          message={detailState.error}
          onRetry={() => void detailState.reload()}
        />
      </div>
    );
  }

  if (!detail || !investigation) {
    return (
      <div className="space-y-4">
        <Button variant="secondary" size="sm" icon="arrow_back" onClick={() => navigate('/investigations')}>
          Back to investigations
        </Button>
        <ErrorState
          title="Investigation not found"
          message="It may have been removed, or it belongs to another organization."
        />
      </div>
    );
  }

  const closed = investigation.status === 'closed';
  const storedCollection = collection ?? lastCollection(detail.activity);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <>
            <button
              onClick={() => navigate('/investigations')}
              className="flex items-center gap-1 font-mono text-label-sm uppercase tracking-wider text-primary hover:underline"
            >
              <Icon name="arrow_back" size={14} /> Investigations
            </button>
            <span className="h-1 w-1 rounded-full bg-outline" />
            <span className="font-mono text-label-sm text-outline">
              INV-{shortId(investigation.id, 6)}
            </span>
            <Badge tone={investigationStatusTone(investigation.status)}>
              {investigation.status}
            </Badge>
            <Badge tone={severityTone(investigation.severity)}>
              {investigation.severity}
            </Badge>
          </>
        }
        title={investigation.title}
        description={`Owned by ${ownerLabel(investigation)} · updated ${relativeTime(
          investigation.updatedAt
        )}`}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon="refresh"
              onClick={() => void refreshAll()}
              disabled={detailState.loading}
            >
              Refresh
            </Button>
            <Button
              size="sm"
              icon="edit"
              onClick={() => {
                setEditError(null);
                setEditing(true);
              }}
              disabled={closed}
              title={closed ? 'A closed investigation can only be reopened' : undefined}
            >
              Edit
            </Button>
          </>
        }
      />

      <Panel title="Lifecycle" icon="flag">
        <StatusControls investigation={investigation} onChanged={refreshAll} />
      </Panel>

      <Tabs<TabID>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview', icon: 'info' },
          { id: 'evidence', label: 'Evidence', icon: 'inventory_2', count: detail.evidence.length },
          {
            id: 'analysis',
            label: 'Analysis',
            icon: 'neurology',
            count: analysisState.data?.hypotheses.length,
          },
          {
            id: 'actions',
            label: 'Action items',
            icon: 'checklist',
            count: actionItemsState.data?.summary.total,
          },
          {
            id: 'timeline',
            label: 'Timeline',
            icon: 'timeline',
            count: timelineState.data?.events.length,
          },
          { id: 'discussion', label: 'Discussion', icon: 'forum' },
        ]}
      />

      {tab === 'overview' ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Problem statement" icon="description">
            <p className="whitespace-pre-wrap font-body text-body-md leading-relaxed text-on-surface">
              {investigation.description}
            </p>

            <dl className="mt-4 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
              <Fact label="Severity">{titleCase(investigation.severity)}</Fact>
              <Fact label="Service">{investigation.service ?? 'Not recorded'}</Fact>
              <Fact label="Error signature">
                {investigation.errorSignature ? (
                  <span className="font-mono text-code-sm">{investigation.errorSignature}</span>
                ) : (
                  'Not recorded'
                )}
              </Fact>
              <Fact label="Source types">
                {investigation.sourceTypes && investigation.sourceTypes.length > 0
                  ? investigation.sourceTypes.map(titleCase).join(', ')
                  : 'All source types'}
              </Fact>
              <Fact label="Window start">
                {investigation.windowStart ? formatDateTime(investigation.windowStart) : 'Not recorded'}
              </Fact>
              <Fact label="Window end">
                {investigation.windowEnd ? formatDateTime(investigation.windowEnd) : 'Not recorded'}
              </Fact>
              <Fact label="Owner">{ownerLabel(investigation)}</Fact>
              <Fact label="Created by">
                {investigation.createdByEmail ?? investigation.createdBy}
              </Fact>
              <Fact label="Created">{formatDateTime(investigation.createdAt)}</Fact>
              <Fact label="Last updated">{formatDateTime(investigation.updatedAt)}</Fact>
            </dl>

            {investigation.resolutionSummary ? (
              <div className="mt-4 rounded border border-success-line bg-success-surface px-3 py-2">
                <div className="mono-label text-success-ink">Resolution summary</div>
                <p className="mt-1 whitespace-pre-wrap font-body text-body-md text-on-surface">
                  {investigation.resolutionSummary}
                </p>
                <p className="mt-1 font-mono text-label-sm text-outline">
                  resolved {relativeTime(investigation.resolvedAt)}
                  {investigation.closedAt
                    ? ` · closed ${relativeTime(investigation.closedAt)}`
                    : ''}
                </p>
              </div>
            ) : null}
          </Panel>

          <Panel
            title="Activity"
            icon="history"
            meta={`${detail.activity.length} recorded`}
            flush
          >
            <ActivityFeed activity={detail.activity} />
          </Panel>
        </div>
      ) : null}

      {tab === 'evidence' ? (
        <Panel
          title="Evidence"
          icon="inventory_2"
          meta={`${detail.evidence.length} linked`}
          flush
        >
          <EvidencePanel
            investigationId={investigation.id}
            evidence={detail.evidence}
            lastCollection={storedCollection}
            closed={closed}
            onChanged={refreshAfterEvidence}
          />
        </Panel>
      ) : null}

      {tab === 'analysis' ? (
        <Panel title="Analysis" icon="neurology">
          {analysisState.error ? (
            <InlineError
              message={analysisState.error}
              onRetry={() => void analysisState.reload()}
            />
          ) : (
            <AnalysisPanel
              investigationId={investigation.id}
              analysis={analysisState.data?.analysis ?? null}
              hypotheses={analysisState.data?.hypotheses ?? []}
              closed={closed}
              loading={analysisState.loading}
              onChanged={refreshAll}
              onCreateActionItem={(suggestion) => {
                setActionDraft(suggestion);
                setTab('actions');
              }}
            />
          )}
        </Panel>
      ) : null}

      {tab === 'actions' ? (
        <Panel
          title="Action items"
          icon="checklist"
          meta={
            actionItemsState.data
              ? `${actionItemsState.data.summary.total} total`
              : undefined
          }
        >
          <ActionItemPanel
            investigationId={investigation.id}
            data={actionItemsState.data}
            loading={actionItemsState.loading}
            error={actionItemsState.error}
            members={membersState.data?.members ?? []}
            membersLoading={membersState.loading}
            closed={closed}
            draft={actionDraft}
            onDraftConsumed={() => setActionDraft(null)}
            onChanged={async () => {
              await actionItemsState.reload(true);
            }}
            onRetry={() => void actionItemsState.reload()}
          />
        </Panel>
      ) : null}

      {tab === 'timeline' ? (
        <Panel title="Timeline" icon="timeline" flush>
          {timelineState.error ? (
            <div className="p-md">
              <InlineError
                message={timelineState.error}
                onRetry={() => void timelineState.reload()}
              />
            </div>
          ) : timelineState.loading && !timelineState.data ? (
            <LoadingState label="Building the timeline…" />
          ) : timelineState.data ? (
            <TimelinePanel timeline={timelineState.data} />
          ) : null}
        </Panel>
      ) : null}

      {tab === 'discussion' ? (
        <DiscussionPanel
          investigationId={investigation.id}
          activity={detail.activity}
          onChanged={async () => {
            await detailState.reload(true);
          }}
        />
      ) : null}

      <Modal
        open={editing}
        onClose={() => {
          if (saving) return;
          setEditing(false);
          setEditError(null);
        }}
        title="Edit investigation"
        description="Changing the owner is recorded in the activity history. The statement cannot be edited once the investigation is closed."
        width="max-w-3xl"
      >
        <InvestigationForm
          mode="edit"
          initial={investigation}
          members={membersState.data?.members ?? []}
          membersLoading={membersState.loading}
          submitting={saving}
          error={editError}
          onSubmit={(payload) => void saveEdit(payload)}
          onCancel={() => {
            if (saving) return;
            setEditing(false);
            setEditError(null);
          }}
        />
      </Modal>
    </div>
  );
}
