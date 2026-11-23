import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, relativeTime, titleCase } from '../../lib/format';
import {
  ALLOWED_ACTION_ITEM_TRANSITIONS,
  actionItemAssigneeLabel,
  actionItemPriorityTone,
  actionItemStatusTone,
} from '../../lib/investigation';
import type {
  ActionItem,
  ActionItemEvent,
  ActionItemList,
  ActionItemStatus,
  ActionItemSuggestion,
  CreateActionItemInput,
  OrganizationMember,
  UpdateActionItemInput,
} from '../../lib/types';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  InlineError,
  LoadingState,
  Modal,
} from '../ui';
import { ActionItemForm } from './ActionItemForm';

const EVENT_LABELS: Record<string, string> = {
  created: 'Created',
  status_change: 'Status changed',
  assignee_change: 'Assignee changed',
  priority_change: 'Priority changed',
  due_change: 'Due date changed',
  details_change: 'Details updated',
};

function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? titleCase(type);
}

function isOverdue(item: ActionItem): boolean {
  return (
    item.status !== 'completed' &&
    item.dueAt !== null &&
    new Date(item.dueAt).getTime() < Date.now()
  );
}

function statusActionLabel(
  from: ActionItemStatus,
  to: ActionItemStatus
): string {
  if (to === 'in_progress') return from === 'blocked' ? 'Resume' : 'Start';
  if (to === 'open') {
    if (from === 'completed') return 'Reopen';
    if (from === 'blocked') return 'Reset to open';
    return 'Pause';
  }
  if (to === 'blocked') return 'Block';
  return 'Complete';
}

function statusActionIcon(from: ActionItemStatus, to: ActionItemStatus): string {
  if (to === 'in_progress') return 'play_arrow';
  if (to === 'open') return from === 'in_progress' ? 'pause' : 'undo';
  if (to === 'blocked') return 'block';
  return 'check';
}

export function ActionItemPanel({
  investigationId,
  data,
  loading,
  error,
  members,
  membersLoading = false,
  closed,
  onChanged,
  onRetry,
  draft = null,
  onDraftConsumed,
}: {
  investigationId: string;
  data: ActionItemList | null;
  loading: boolean;
  error: string | null;
  members: OrganizationMember[];
  membersLoading?: boolean;
  closed: boolean;
  onChanged: () => Promise<void>;
  onRetry: () => void;
  draft?: ActionItemSuggestion | null;
  onDraftConsumed?: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [editingItem, setEditingItem] = useState<ActionItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [busyTarget, setBusyTarget] = useState<ActionItemStatus | null>(null);

  const [blockTarget, setBlockTarget] = useState<ActionItem | null>(null);
  const [blockReason, setBlockReason] = useState('');
  const [blockError, setBlockError] = useState<string | null>(null);
  const [blocking, setBlocking] = useState(false);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, ActionItemEvent[]>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>(
    {}
  );
  const [historyError, setHistoryError] = useState<Record<string, string | null>>(
    {}
  );

  useEffect(() => {
    if (draft && !closed) {
      setCreating(true);
      setEditingItem(null);
      setFormError(null);
    }
  }, [draft, closed]);

  const items = data?.items ?? [];
  const summary = data?.summary ?? {
    total: 0,
    open: 0,
    inProgress: 0,
    blocked: 0,
    completed: 0,
    overdue: 0,
  };

  const closeForm = () => {
    if (submitting) return;
    setCreating(false);
    setEditingItem(null);
    setFormError(null);
    onDraftConsumed?.();
  };

  const openCreate = () => {
    setCreating(true);
    setEditingItem(null);
    setFormError(null);
    setActionError(null);
    setSuccess(null);
  };

  const openEdit = (item: ActionItem) => {
    setEditingItem(item);
    setCreating(false);
    setFormError(null);
    setActionError(null);
    setSuccess(null);
  };

  const submitForm = async (
    payload: CreateActionItemInput | UpdateActionItemInput
  ) => {
    setSubmitting(true);
    setFormError(null);
    setSuccess(null);

    try {
      if (editingItem) {
        await api.actionItems.update(
          investigationId,
          editingItem.id,
          payload as UpdateActionItemInput
        );
        setSuccess('Action item updated.');
      } else {
        await api.actionItems.create(
          investigationId,
          payload as CreateActionItemInput
        );
        setSuccess('Action item created.');
      }

      setCreating(false);
      setEditingItem(null);
      setFormError(null);
      onDraftConsumed?.();
      await onChanged();
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const refreshHistory = async (itemId: string) => {
    setHistoryLoading((current) => ({ ...current, [itemId]: true }));
    setHistoryError((current) => ({ ...current, [itemId]: null }));

    try {
      const detail = await api.actionItems.get(investigationId, itemId);
      setHistory((current) => ({ ...current, [itemId]: detail.events }));
    } catch (caught) {
      setHistoryError((current) => ({
        ...current,
        [itemId]: errorMessage(caught),
      }));
    } finally {
      setHistoryLoading((current) => ({ ...current, [itemId]: false }));
    }
  };

  const toggleHistory = async (itemId: string) => {
    if (expanded === itemId) {
      setExpanded(null);
      return;
    }

    setExpanded(itemId);

    if (history[itemId]) return;
    await refreshHistory(itemId);
  };

  const changeStatus = async (item: ActionItem, status: ActionItemStatus) => {
    if (status === 'blocked') {
      setBlockTarget(item);
      setBlockReason('');
      setBlockError(null);
      return;
    }

    setBusyItem(item.id);
    setBusyTarget(status);
    setActionError(null);
    setSuccess(null);

    try {
      await api.actionItems.update(investigationId, item.id, {
        status,
        expectedUpdatedAt: item.updatedAt,
      });

      setSuccess(`Action item moved to ${titleCase(status)}.`);
      await onChanged();

      if (expanded === item.id) {
        await refreshHistory(item.id);
      }
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyItem(null);
      setBusyTarget(null);
    }
  };

  const submitBlock = async () => {
    if (!blockTarget) return;

    const reason = blockReason.trim();
    if (!reason) {
      setBlockError('A blocked reason is required.');
      return;
    }

    setBlocking(true);
    setBlockError(null);

    try {
      await api.actionItems.update(investigationId, blockTarget.id, {
        status: 'blocked',
        blockedReason: reason,
        expectedUpdatedAt: blockTarget.updatedAt,
      });

      const blockedId = blockTarget.id;
      setBlockTarget(null);
      setBlockReason('');
      setSuccess('Action item blocked.');
      await onChanged();

      if (expanded === blockedId) {
        await refreshHistory(blockedId);
      }
    } catch (caught) {
      setBlockError(errorMessage(caught));
    } finally {
      setBlocking(false);
    }
  };

  if (loading && !data) {
    return <LoadingState label="Loading action items…" />;
  }

  if (error && !data) {
    return (
      <ErrorState
        title="Could not load action items"
        message={error}
        onRetry={onRetry}
        compact
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="primary">{summary.open} open</Badge>
        <Badge tone="warn">{summary.inProgress} in progress</Badge>
        <Badge tone="critical">{summary.blocked} blocked</Badge>
        <Badge tone="ok">{summary.completed} completed</Badge>
        {summary.overdue > 0 ? (
          <Badge tone="critical" icon="schedule">
            {summary.overdue} overdue
          </Badge>
        ) : null}
        <Button
          size="sm"
          icon="add"
          className="ml-auto"
          onClick={openCreate}
          disabled={closed}
          title={
            closed
              ? 'A closed investigation cannot receive new action items'
              : undefined
          }
        >
          New action item
        </Button>
      </div>

      {closed ? (
        <p className="rounded border border-line bg-surface-low px-2.5 py-2 font-body text-body-sm text-outline">
          This investigation is closed, so new action items cannot be added.
          Existing items can still be updated and completed.
        </p>
      ) : null}

      {actionError ? <InlineError message={actionError} /> : null}
      {error ? <InlineError message={error} onRetry={onRetry} /> : null}
      {success ? (
        <p className="flex items-center gap-1.5 rounded border border-success-line bg-success-surface px-2.5 py-1.5 font-body text-body-sm text-success-ink">
          <Icon name="check_circle" size={14} /> {success}
        </p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          compact
          icon="checklist"
          title="No action items yet"
          description="Action items are written by people. An analysis suggestion can pre-fill this form, but it never creates or completes work on its own."
        />
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const busy = busyItem === item.id;
            const overdue = isOverdue(item);
            const targets = ALLOWED_ACTION_ITEM_TRANSITIONS[item.status] ?? [];
            const isExpanded = expanded === item.id;

            return (
              <article
                key={item.id}
                className="rounded border border-line bg-surface-low p-3"
              >
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={actionItemStatusTone(item.status)}>
                        {titleCase(item.status)}
                      </Badge>
                      <Badge tone={actionItemPriorityTone(item.priority)}>
                        {item.priority}
                      </Badge>
                      {item.createdFrom === 'analysis' ? (
                        <Badge tone="ai" icon="auto_awesome">
                          from analysis
                        </Badge>
                      ) : null}
                      {overdue ? (
                        <Badge tone="critical" icon="schedule">
                          overdue
                        </Badge>
                      ) : null}
                    </div>

                    <h3 className="mt-1.5 break-words font-body text-body-md font-medium text-on-surface">
                      {item.title}
                    </h3>

                    {item.description ? (
                      <p className="mt-1 whitespace-pre-wrap font-body text-body-sm text-on-surface-variant">
                        {item.description}
                      </p>
                    ) : null}

                    {item.blockedReason ? (
                      <div className="mt-2 rounded border border-warning-line bg-warning-surface px-2.5 py-1.5 font-body text-body-sm text-warning-ink">
                        <span className="mono-label">Blocked</span>
                        <p className="mt-0.5 whitespace-pre-wrap">
                          {item.blockedReason}
                        </p>
                      </div>
                    ) : null}

                    {item.createdFrom === 'analysis' ? (
                      <div className="mt-2 rounded border border-ai-border bg-ai-surface px-2.5 py-1.5">
                        <div className="flex items-center gap-1 font-mono text-label-sm font-semibold uppercase tracking-wider text-ai-ink">
                          <Icon name="auto_awesome" size={12} />
                          Accepted suggestion
                        </div>
                        <p className="mt-0.5 whitespace-pre-wrap font-body text-body-sm text-on-surface-variant">
                          {item.sourceLabel ??
                            'The original suggestion is no longer available.'}
                        </p>
                        <p className="mt-0.5 font-body text-[11px] text-outline">
                          Written by {item.createdByEmail ?? item.createdBy}. The
                          model did not create or complete this item.
                        </p>
                      </div>
                    ) : null}

                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-label-sm text-outline">
                      <span>Assignee: {actionItemAssigneeLabel(item)}</span>
                      <span>
                        Due:{' '}
                        {item.dueAt ? (
                          <span className={overdue ? 'text-critical-ink' : undefined}>
                            {formatDateTime(item.dueAt)}
                          </span>
                        ) : (
                          'none'
                        )}
                      </span>
                      <span>
                        Created {relativeTime(item.createdAt)} by{' '}
                        {item.createdByEmail ?? item.createdBy}
                      </span>
                      {item.completedAt ? (
                        <span>
                          Completed {relativeTime(item.completedAt)} by{' '}
                          {item.completedByEmail ?? item.completedBy ?? 'unknown'}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="edit"
                      onClick={() => openEdit(item)}
                      disabled={busy}
                    >
                      Edit
                    </Button>
                    {targets.map((target) => (
                      <Button
                        key={target}
                        size="sm"
                        variant={target === 'completed' ? 'primary' : 'secondary'}
                        icon={statusActionIcon(item.status, target)}
                        disabled={busy}
                        onClick={() => void changeStatus(item, target)}
                      >
                        {busy && busyTarget === target
                          ? 'Working…'
                          : statusActionLabel(item.status, target)}
                      </Button>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="history"
                      onClick={() => void toggleHistory(item.id)}
                    >
                      {isExpanded ? 'Hide history' : 'History'}
                    </Button>
                  </div>
                </div>

                {isExpanded ? (
                  <div className="mt-2 border-t border-line pt-2">
                    {historyLoading[item.id] ? (
                      <p className="font-body text-body-sm text-outline">
                        Loading history…
                      </p>
                    ) : historyError[item.id] ? (
                      <InlineError
                        message={historyError[item.id] ?? 'Could not load history.'}
                        onRetry={() => void refreshHistory(item.id)}
                      />
                    ) : history[item.id]?.length ? (
                      <ol className="space-y-1">
                        {history[item.id]?.map((event) => (
                          <li
                            key={event.id}
                            className="flex flex-wrap items-baseline gap-1.5 font-body text-body-sm"
                          >
                            <Badge tone="neutral">{eventLabel(event.type)}</Badge>
                            <span className="font-mono text-label-sm text-outline">
                              {event.actorEmail ?? 'system'}
                            </span>
                            <span className="text-on-surface-variant">
                              {event.body}
                            </span>
                            <span
                              className="ml-auto font-mono text-label-sm text-outline"
                              title={formatDateTime(event.createdAt)}
                            >
                              {relativeTime(event.createdAt)}
                            </span>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="font-body text-body-sm text-outline">
                        No history recorded yet.
                      </p>
                    )}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      <Modal
        open={creating || editingItem !== null}
        onClose={closeForm}
        title={editingItem ? 'Edit action item' : 'New action item'}
        description={
          editingItem
            ? 'Changes are recorded in the action item history.'
            : 'A person writes the item; an analysis suggestion can only pre-fill it.'
        }
        width="max-w-2xl"
      >
        <ActionItemForm
          key={editingItem?.id ?? `new-${draft?.sourceLabel ?? ''}`}
          mode={editingItem ? 'edit' : 'create'}
          initial={editingItem ?? undefined}
          draft={editingItem ? null : draft}
          members={members}
          membersLoading={membersLoading}
          submitting={submitting}
          error={formError}
          onSubmit={(payload) => void submitForm(payload)}
          onCancel={closeForm}
        />
      </Modal>

      <Modal
        open={blockTarget !== null}
        onClose={() => {
          if (blocking) return;
          setBlockTarget(null);
          setBlockReason('');
          setBlockError(null);
        }}
        title="Block action item"
        description="A blocked item needs a reason so the next person knows what to unblock."
        width="max-w-xl"
        footer={
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={blocking}
              onClick={() => {
                setBlockTarget(null);
                setBlockReason('');
                setBlockError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              icon="block"
              disabled={blocking}
              onClick={() => void submitBlock()}
            >
              {blocking ? 'Blocking…' : 'Block item'}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          {blockError ? <InlineError message={blockError} /> : null}
          <Field label="Blocked reason" hint="Required. What is preventing progress?">
            <textarea
              className="textarea min-h-[100px]"
              value={blockReason}
              onChange={(event) => setBlockReason(event.target.value)}
              maxLength={1000}
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
