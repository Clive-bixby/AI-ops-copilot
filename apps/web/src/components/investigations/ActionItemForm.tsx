import { useState } from 'react';
import {
  ACTION_ITEM_PRIORITIES,
  fromDateTimeLocal,
  toDateTimeLocal,
} from '../../lib/investigation';
import type {
  ActionItem,
  ActionItemPriority,
  ActionItemSuggestion,
  CreateActionItemInput,
  OrganizationMember,
  UpdateActionItemInput,
} from '../../lib/types';
import { Button, Field, Icon, InlineError } from '../ui';

/**
 * One form for creating and editing an action item.
 *
 * A suggestion only pre-fills the form. Nothing is written until the person
 * submits it, and the backend records the item as analysis-derived provenance
 * with that person as its author.
 */
export function ActionItemForm({
  mode,
  initial,
  draft,
  members,
  membersLoading = false,
  submitting,
  error,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'edit';
  initial?: ActionItem;
  draft?: ActionItemSuggestion | null;
  members: OrganizationMember[];
  membersLoading?: boolean;
  submitting: boolean;
  error: string | null;
  onSubmit: (payload: CreateActionItemInput | UpdateActionItemInput) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(
    initial?.title ?? (draft ? draft.title.slice(0, 200) : '')
  );
  const [description, setDescription] = useState(initial?.description ?? '');
  const [priority, setPriority] = useState<ActionItemPriority>(
    initial?.priority ?? 'medium'
  );
  const [assigneeUserId, setAssigneeUserId] = useState(
    initial?.assigneeUserId ?? ''
  );
  const [dueAt, setDueAt] = useState(toDateTimeLocal(initial?.dueAt));
  const [validationError, setValidationError] = useState<string | null>(null);

  const submit = () => {
    setValidationError(null);

    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();

    if (trimmedTitle.length < 3 || trimmedTitle.length > 200) {
      setValidationError('Title must be between 3 and 200 characters.');
      return;
    }

    if (trimmedDescription.length > 4000) {
      setValidationError('Description must be no more than 4000 characters.');
      return;
    }

    const base = {
      title: trimmedTitle,
      description: trimmedDescription ? trimmedDescription : null,
      priority,
      assigneeUserId: assigneeUserId || null,
      dueAt: fromDateTimeLocal(dueAt),
    };

    if (mode === 'create') {
      const payload: CreateActionItemInput = { ...base };

      if (draft) {
        payload.createdFrom = 'analysis';
        payload.sourceAnalysisId = draft.sourceAnalysisId;
        payload.sourceHypothesisId = draft.sourceHypothesisId;
        payload.sourceLabel = draft.sourceLabel;
      }

      onSubmit(payload);
      return;
    }

    onSubmit({
      ...base,
      expectedUpdatedAt: initial?.updatedAt,
    });
  };

  return (
    <div className="space-y-4">
      {error ? <InlineError message={error} /> : null}
      {validationError ? <InlineError message={validationError} /> : null}

      {draft ? (
        <div className="rounded border border-ai-border bg-ai-surface px-3 py-2">
          <div className="flex items-center gap-1.5 font-label-lg text-label-lg text-ai-ink">
            <Icon name="auto_awesome" size={14} />
            From an analysis suggestion
          </div>
          <p className="mt-1 whitespace-pre-wrap font-body text-body-sm text-on-surface-variant">
            {draft.sourceLabel}
          </p>
          <p className="mt-1 font-body text-body-sm text-outline">
            Creating this item records you as its author. The model did not create,
            execute or complete it.
          </p>
        </div>
      ) : null}

      {initial?.createdFrom === 'analysis' ? (
        <div className="rounded border border-ai-border bg-ai-surface px-3 py-2">
          <div className="flex items-center gap-1.5 font-label-lg text-label-lg text-ai-ink">
            <Icon name="auto_awesome" size={14} />
            Accepted from an analysis suggestion
          </div>
          <p className="mt-1 whitespace-pre-wrap font-body text-body-sm text-on-surface-variant">
            {initial.sourceLabel ?? 'The original suggestion is no longer available.'}
          </p>
          <p className="mt-1 font-body text-body-sm text-outline">
            Provenance is read-only. This item was written by{' '}
            {initial.createdByEmail ?? initial.createdBy}.
          </p>
        </div>
      ) : null}

      <Field label="Title">
        <input
          className="input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What needs to be done?"
          maxLength={200}
        />
      </Field>

      <Field
        label="Description"
        hint="Optional. Facts, acceptance criteria, or a link to the evidence."
      >
        <textarea
          className="textarea min-h-[100px]"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={4000}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Priority">
          <select
            className="select"
            value={priority}
            onChange={(event) =>
              setPriority(event.target.value as ActionItemPriority)
            }
          >
            {ACTION_ITEM_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Assignee" hint="Any organization member can be assigned.">
          <select
            className="select"
            value={assigneeUserId}
            onChange={(event) => setAssigneeUserId(event.target.value)}
            disabled={membersLoading}
          >
            <option value="">Unassigned</option>
            {members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.email}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Due date" hint="Optional. Local time.">
        <input
          type="datetime-local"
          className="input"
          value={dueAt}
          onChange={(event) => setDueAt(event.target.value)}
        />
      </Field>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          icon={mode === 'create' ? 'add' : 'save'}
          onClick={submit}
          disabled={submitting || membersLoading}
        >
          {submitting
            ? mode === 'create'
              ? 'Creating…'
              : 'Saving…'
            : mode === 'create'
              ? 'Create action item'
              : 'Save changes'}
        </Button>
      </div>

      {membersLoading ? (
        <p className="flex items-center gap-1.5 font-body text-body-sm text-outline">
          <Icon name="sync" size={14} className="animate-spin" />
          Loading organization members…
        </p>
      ) : null}
    </div>
  );
}
