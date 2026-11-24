import { useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useApiData } from '../lib/hooks';
import { formatNumber, relativeTime, shortId, titleCase } from '../lib/format';
import {
  ACTION_ITEM_PRIORITIES,
  ACTION_ITEM_STATUSES,
  actionItemPriorityTone,
  actionItemStatusTone,
  investigationStatusTone,
  severityTone,
} from '../lib/investigation';
import type {
  OperationsActionItem,
  OperationsActionItemList,
  OperationsOverview,
} from '../lib/types';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  InlineError,
  LoadingState,
  PageHeader,
  Pagination,
  Panel,
  Stat,
  Tabs,
} from '../components/ui';

const PAGE_SIZE = 25;

type TabID = 'overview' | 'action-items';

function DistributionRow({
  label,
  count,
  total,
}: {
  label: string;
  count: number;
  total: number;
}) {
  const percent = total > 0 ? Math.round((count / total) * 100) : 0;

  return (
    <div className="flex items-center gap-2 py-1">
      <span className="w-24 shrink-0 font-mono text-label-sm uppercase tracking-wider text-on-surface-variant">
        {label}
      </span>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-container">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="w-10 shrink-0 text-right font-mono text-label-sm tabular text-on-surface">
        {formatNumber(count)}
      </span>
    </div>
  );
}

function InvestigationRow({
  id,
  title,
  status,
  severity,
  ownerEmail,
  at,
  atLabel,
}: {
  id: string;
  title: string;
  status: string;
  severity: string;
  ownerEmail: string | null;
  at: string | null;
  atLabel: string;
}) {
  return (
    <Link
      to={`/investigations/${id}`}
      className="flex flex-col gap-1 border-b border-line px-md py-2.5 transition-colors last:border-b-0 hover:bg-surface-low"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={investigationStatusTone(status)}>{status}</Badge>
        <Badge tone={severityTone(severity)}>{severity}</Badge>
        <span className="ml-auto font-mono text-label-sm text-outline">
          {atLabel} {relativeTime(at)}
        </span>
      </div>
      <span className="truncate font-label-lg text-label-lg font-semibold text-on-surface">
        {title}
      </span>
      <span className="font-mono text-label-sm text-outline">
        INV-{shortId(id, 6)} · owner {ownerEmail ?? 'unassigned'}
      </span>
    </Link>
  );
}

function OperationsOverviewTab({
  overview,
  loading,
  error,
  onRetry,
}: {
  overview: OperationsOverview | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (loading && !overview) {
    return <LoadingState label="Counting operational work…" />;
  }

  if (!overview) {
    return (
      <ErrorState
        title="Could not load the operational overview"
        message={error ?? 'The overview is unavailable.'}
        onRetry={onRetry}
      />
    );
  }

  const investigations = overview.investigations;
  const actionItems = overview.actionItems.summary;
  const openInvestigations =
    investigations.open + investigations.investigating;

  return (
    <div className="space-y-gutter-desktop">
      {error ? <InlineError message={error} onRetry={onRetry} /> : null}

      <div className="panel grid grid-cols-2 divide-x divide-y divide-line overflow-hidden md:grid-cols-5 md:divide-y-0">
        <Stat
          label="Investigations"
          value={formatNumber(investigations.total)}
          icon="radar"
          hint={`${formatNumber(openInvestigations)} still open`}
        />
        <Stat
          label="Unassigned"
          value={formatNumber(investigations.unassigned)}
          icon="person_alert"
          tone={investigations.unassigned > 0 ? 'critical' : 'default'}
          hint={`${formatNumber(investigations.assignedToMe)} assigned to you`}
        />
        <Stat
          label="Action items"
          value={formatNumber(actionItems.total)}
          icon="checklist"
          hint={`${formatNumber(actionItems.blocked)} blocked · ${formatNumber(
            actionItems.completed
          )} completed`}
        />
        <Stat
          label="Overdue"
          value={formatNumber(actionItems.overdue)}
          icon="schedule"
          tone={actionItems.overdue > 0 ? 'critical' : 'default'}
          hint="Unfinished and past due"
        />
        <Stat
          label={`Due in ${overview.dueSoonHours}h`}
          value={formatNumber(actionItems.dueSoon)}
          icon="timer"
          hint={`${formatNumber(actionItems.unassigned)} items unassigned`}
        />
      </div>

      <div className="grid items-start gap-gutter-desktop lg:grid-cols-2">
        <Panel title="Investigations by status" icon="donut_small">
          {Object.entries(investigations.byStatus).map(([status, count]) => (
            <DistributionRow
              key={status}
              label={titleCase(status)}
              count={count}
              total={investigations.total}
            />
          ))}
          <div className="mt-md border-t border-line pt-sm">
            {Object.entries(investigations.bySeverity).map(([severity, count]) => (
              <DistributionRow
                key={severity}
                label={titleCase(severity)}
                count={count}
                total={investigations.total}
              />
            ))}
          </div>
        </Panel>

        <Panel title="Action items by status" icon="checklist">
          {Object.entries(overview.actionItems.byStatus).map(([status, count]) => (
            <DistributionRow
              key={status}
              label={titleCase(status)}
              count={count}
              total={overview.actionItems.summary.total}
            />
          ))}
          <div className="mt-md border-t border-line pt-sm">
            {Object.entries(overview.actionItems.byPriority).map(
              ([priority, count]) => (
                <DistributionRow
                  key={priority}
                  label={titleCase(priority)}
                  count={count}
                  total={overview.actionItems.summary.total}
                />
              )
            )}
          </div>
        </Panel>
      </div>

      <div className="grid items-start gap-gutter-desktop lg:grid-cols-2">
        <Panel
          title="Recently updated"
          icon="history"
          meta={`${investigations.recentlyUpdated.length} shown`}
          flush
        >
          {investigations.recentlyUpdated.length === 0 ? (
            <EmptyState
              compact
              icon="radar"
              title="No investigations recorded"
              description="Create an investigation to start tracking a problem."
            />
          ) : (
            investigations.recentlyUpdated.map((item) => (
              <InvestigationRow
                key={item.id}
                id={item.id}
                title={item.title}
                status={item.status}
                severity={item.severity}
                ownerEmail={item.ownerEmail}
                at={item.updatedAt}
                atLabel="updated"
              />
            ))
          )}
        </Panel>

        <Panel
          title="Recently resolved"
          icon="task_alt"
          meta={`${investigations.recentlyResolved.length} shown`}
          flush
        >
          {investigations.recentlyResolved.length === 0 ? (
            <EmptyState
              compact
              icon="task_alt"
              title="Nothing resolved yet"
              description="Resolved investigations show up here with the moment they were resolved."
            />
          ) : (
            investigations.recentlyResolved.map((item) => (
              <InvestigationRow
                key={item.id}
                id={item.id}
                title={item.title}
                status={item.status}
                severity={item.severity}
                ownerEmail={item.ownerEmail}
                at={item.resolvedAt}
                atLabel="resolved"
              />
            ))
          )}
        </Panel>
      </div>

      <Panel
        title="Recently completed action items"
        icon="playlist_add_check"
        meta={`${overview.actionItems.recentlyCompleted.length} shown`}
        flush
      >
        {overview.actionItems.recentlyCompleted.length === 0 ? (
          <EmptyState
            compact
            icon="playlist_add_check"
            title="No completed action items"
            description="Completing an action item records who completed it and when."
          />
        ) : (
          overview.actionItems.recentlyCompleted.map((item) => (
            <Link
              key={item.id}
              to={`/investigations/${item.investigationId}`}
              className="flex flex-col gap-1 border-b border-line px-md py-2.5 transition-colors last:border-b-0 hover:bg-surface-low"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={actionItemStatusTone(item.status)}>{item.status}</Badge>
                <Badge tone={actionItemPriorityTone(item.priority)}>
                  {item.priority}
                </Badge>
                <span className="ml-auto font-mono text-label-sm text-outline">
                  completed {relativeTime(item.completedAt)}
                </span>
              </div>
              <span className="truncate font-label-lg text-label-lg font-semibold text-on-surface">
                {item.title}
              </span>
              <span className="font-mono text-label-sm text-outline">
                {item.investigationTitle} · {item.assigneeEmail ?? 'unassigned'}
              </span>
            </Link>
          ))
        )}
      </Panel>
    </div>
  );
}

function ActionItemRow({ item, now }: { item: OperationsActionItem; now: number }) {
  const overdue = item.dueAt !== null && new Date(item.dueAt).getTime() < now;

  return (
    <Link
      to={`/investigations/${item.investigationId}`}
      className="flex flex-col gap-1 border-b border-line px-md py-2.5 transition-colors last:border-b-0 hover:bg-surface-low"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={actionItemStatusTone(item.status)}>{item.status}</Badge>
        <Badge tone={actionItemPriorityTone(item.priority)}>{item.priority}</Badge>
        {item.createdFrom === 'analysis' ? (
          <Badge tone="ai" icon="auto_awesome">
            analysis
          </Badge>
        ) : null}
        <span
          className={clsx(
            'ml-auto font-mono text-label-sm',
            overdue ? 'text-critical-ink' : 'text-outline'
          )}
        >
          {item.dueAt ? `due ${relativeTime(item.dueAt)}` : 'no due date'} · updated{' '}
          {relativeTime(item.updatedAt)}
        </span>
      </div>
      <span className="truncate font-label-lg text-label-lg font-semibold text-on-surface">
        {item.title}
      </span>
      <span className="truncate font-mono text-label-sm text-outline">
        {item.investigationTitle} · {item.assigneeEmail ?? 'unassigned'}
        {item.blockedReason ? ` · blocked: ${item.blockedReason}` : ''}
      </span>
    </Link>
  );
}

export function Operations() {
  const [tab, setTab] = useState<TabID>('overview');

  const overviewState = useApiData<OperationsOverview>(
    () => api.insights.operations(),
    []
  );
  const membersState = useApiData(() => api.organization.members(), []);

  const [status, setStatus] = useState('all');
  const [priority, setPriority] = useState('all');
  const [assignee, setAssignee] = useState('all');
  const [due, setDue] = useState('all');
  const [page, setPage] = useState(1);

  const queueState = useApiData<OperationsActionItemList & { loadedAt: number }>(
    async () => ({
      ...(await api.insights.actionItems({
        status: status === 'all' ? undefined : (status as never),
        priority: priority === 'all' ? undefined : (priority as never),
        assignee: assignee === 'all' ? undefined : assignee,
        due: due === 'all' ? undefined : (due as 'overdue' | 'due_soon'),
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      })),
      // Captured with the response so "overdue" is measured against the data's
      // own clock instead of reading Date.now() while rendering.
      loadedAt: Date.now(),
    }),
    [tab, status, priority, assignee, due, page]
  );

  const resetFilters = () => {
    setStatus('all');
    setPriority('all');
    setAssignee('all');
    setDue('all');
    setPage(1);
  };

  const items = queueState.data?.items ?? [];
  const itemsLoadedAt = queueState.data?.loadedAt ?? 0;
  const total = queueState.data?.total ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <>
            <span className="eyebrow">Operational overview</span>
            <span className="h-1 w-1 rounded-full bg-outline" />
            <span className="font-mono text-label-sm uppercase tracking-wider text-primary">
              Organization scoped
            </span>
          </>
        }
        title="Operations"
        description="Counts, ownership and follow-up work for this organization. Every number is counted by the API; filters and pagination are applied in SQL."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon="refresh"
            onClick={() => {
              void overviewState.reload();
              void queueState.reload();
            }}
            disabled={overviewState.loading}
          >
            Refresh
          </Button>
        }
      >
        <Tabs<TabID>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: 'Overview', icon: 'dashboard' },
            {
              id: 'action-items',
              label: 'Action items',
              icon: 'checklist',
              count: overviewState.data?.actionItems.summary.total,
            },
          ]}
        />
      </PageHeader>

      {tab === 'overview' ? (
        <OperationsOverviewTab
          overview={overviewState.data}
          loading={overviewState.loading}
          error={overviewState.error}
          onRetry={() => void overviewState.reload()}
        />
      ) : (
        <div className="space-y-gutter-desktop">
          <Panel title="Queue" icon="checklist" flush>
            <div className="space-y-2 border-b border-line p-md">
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
                <select
                  value={status}
                  onChange={(event) => {
                    setStatus(event.target.value);
                    setPage(1);
                  }}
                  aria-label="Filter by status"
                  className="select"
                >
                  <option value="all">Status: all</option>
                  {ACTION_ITEM_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {titleCase(value)}
                    </option>
                  ))}
                </select>

                <select
                  value={priority}
                  onChange={(event) => {
                    setPriority(event.target.value);
                    setPage(1);
                  }}
                  aria-label="Filter by priority"
                  className="select"
                >
                  <option value="all">Priority: all</option>
                  {ACTION_ITEM_PRIORITIES.map((value) => (
                    <option key={value} value={value}>
                      {titleCase(value)}
                    </option>
                  ))}
                </select>

                <select
                  value={assignee}
                  onChange={(event) => {
                    setAssignee(event.target.value);
                    setPage(1);
                  }}
                  aria-label="Filter by assignee"
                  className="select"
                >
                  <option value="all">Assignee: anyone</option>
                  <option value="me">Assignee: me</option>
                  <option value="unassigned">Assignee: unassigned</option>
                  {(membersState.data?.members ?? []).map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.email}
                    </option>
                  ))}
                </select>

                <select
                  value={due}
                  onChange={(event) => {
                    setDue(event.target.value);
                    setPage(1);
                  }}
                  aria-label="Filter by due date"
                  className="select"
                >
                  <option value="all">Due: any</option>
                  <option value="overdue">Due: overdue</option>
                  <option value="due_soon">
                    Due: next {overviewState.data?.dueSoonHours ?? 48}h
                  </option>
                </select>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="neutral">{total} matching</Badge>
                  <Badge tone="critical">
                    {queueState.data?.summary.overdue ?? 0} overdue
                  </Badge>
                  <Badge tone="warn">
                    {queueState.data?.summary.dueSoon ?? 0} due soon
                  </Badge>
                  <Badge tone="primary">
                    {queueState.data?.summary.assignedToMe ?? 0} mine
                  </Badge>
                  <Badge tone="neutral">
                    {queueState.data?.summary.unassigned ?? 0} unassigned
                  </Badge>
                </div>
                {status !== 'all' || priority !== 'all' || assignee !== 'all' || due !== 'all' ? (
                  <Button variant="ghost" size="sm" icon="filter_alt_off" onClick={resetFilters}>
                    Reset filters
                  </Button>
                ) : null}
              </div>

              {membersState.error ? (
                <p className="font-body text-body-sm text-warning-ink">
                  Member directory unavailable: {membersState.error}. Assignment filters for
                  specific people are hidden.
                </p>
              ) : null}
            </div>

            {queueState.loading && !queueState.data ? (
              <LoadingState label="Loading action items…" />
            ) : queueState.error && !queueState.data ? (
              <div className="p-md">
                <ErrorState
                  title="Could not load action items"
                  message={queueState.error}
                  onRetry={() => void queueState.reload()}
                />
              </div>
            ) : items.length === 0 ? (
              <EmptyState
                icon="checklist"
                title={
                  total === 0
                    ? 'No action items recorded'
                    : 'No action items match these filters'
                }
                description={
                  total === 0
                    ? 'Action items are created from an investigation and track follow-up work.'
                    : 'Widen the status, priority, assignee or due-date filters.'
                }
                action={
                  total === 0 ? (
                    <Link to="/investigations" className="text-label-lg font-semibold text-primary underline underline-offset-2">
                      Go to investigations
                    </Link>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={resetFilters}>
                      Reset filters
                    </Button>
                  )
                }
              />
            ) : (
              <div>
                {queueState.error ? (
                  <div className="p-md">
                    <InlineError
                      message={queueState.error}
                      onRetry={() => void queueState.reload()}
                    />
                  </div>
                ) : null}
                {items.map((item) => (
                  <ActionItemRow key={item.id} item={item} now={itemsLoadedAt} />
                ))}
                <Pagination
                  page={page}
                  pageSize={PAGE_SIZE}
                  total={total}
                  onPage={setPage}
                  label="action items"
                />
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
