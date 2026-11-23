import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import {
  INVESTIGATION_SEVERITIES,
  fromDateTimeLocal,
  toDateTimeLocal,
} from '../../lib/investigation';
import type {
  CreateInvestigationInput,
  Investigation,
  InvestigationSeverity,
  InvestigationSourceType,
  OrganizationMember,
  UpdateInvestigationInput,
} from '../../lib/types';
import { Button, Field, Icon, InlineError } from '../ui';

const SOURCE_TYPES: Array<{ value: InvestigationSourceType; label: string }> = [
  { value: 'document', label: 'Documents' },
  { value: 'log', label: 'Log groups' },
  { value: 'ticket', label: 'Tickets' },
];

export function InvestigationForm({
  mode,
  initial,
  members,
  membersLoading = false,
  submitting,
  error,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'edit';
  initial?: Investigation;
  members: OrganizationMember[];
  membersLoading?: boolean;
  submitting: boolean;
  error: string | null;
  onSubmit: (payload: CreateInvestigationInput | UpdateInvestigationInput) => void;
  onCancel: () => void;
}) {
  const { session } = useAuth();

  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [severity, setSeverity] = useState<InvestigationSeverity>(
    initial?.severity ?? 'medium'
  );
  const [service, setService] = useState(initial?.service ?? '');
  const [errorSignature, setErrorSignature] = useState(initial?.errorSignature ?? '');
  const [windowStart, setWindowStart] = useState(toDateTimeLocal(initial?.windowStart));
  const [windowEnd, setWindowEnd] = useState(toDateTimeLocal(initial?.windowEnd));
  const [sourceTypes, setSourceTypes] = useState<InvestigationSourceType[]>(
    initial?.sourceTypes ?? []
  );
  const [ownerUserId, setOwnerUserId] = useState(
    initial?.ownerUserId ?? (mode === 'create' ? session?.user.id ?? '' : '')
  );
  const [collectEvidence, setCollectEvidence] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const toggleSourceType = (value: InvestigationSourceType) => {
    setSourceTypes((current) =>
      current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value]
    );
  };

  const submit = () => {
    setValidationError(null);

    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();

    if (trimmedTitle.length < 3 || trimmedTitle.length > 200) {
      setValidationError('Title must be between 3 and 200 characters.');
      return;
    }

    if (trimmedDescription.length < 10 || trimmedDescription.length > 4000) {
      setValidationError('Description must be between 10 and 4000 characters.');
      return;
    }

    const start = fromDateTimeLocal(windowStart);
    const end = fromDateTimeLocal(windowEnd);

    if (start && end && new Date(end).getTime() <= new Date(start).getTime()) {
      setValidationError('The window end must be after the window start.');
      return;
    }

    const base = {
      title: trimmedTitle,
      description: trimmedDescription,
      severity,
      service: service.trim() ? service.trim() : null,
      errorSignature: errorSignature.trim() ? errorSignature.trim() : null,
      windowStart: start,
      windowEnd: end,
      sourceTypes: sourceTypes.length > 0 ? sourceTypes : null,
      ownerUserId: ownerUserId || null,
    };

    if (mode === 'create') {
      onSubmit({ ...base, collectEvidence });
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

      <Field label="Title">
        <input
          className="input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What is happening?"
          maxLength={200}
        />
      </Field>

      <Field label="Problem statement" hint="What was observed, where, and when. Facts only.">
        <textarea
          className="textarea min-h-[110px]"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={4000}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Severity">
          <select
            className="select"
            value={severity}
            onChange={(event) => setSeverity(event.target.value as InvestigationSeverity)}
          >
            {INVESTIGATION_SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Owner" hint="Any organization member can be assigned.">
          <select
            className="select"
            value={ownerUserId}
            onChange={(event) => setOwnerUserId(event.target.value)}
            disabled={membersLoading}
          >
            <option value="">Unassigned</option>
            {members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.email}
                {session?.user.id === member.userId ? ' (you)' : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Service" hint="Optional component or service name.">
          <input
            className="input"
            value={service}
            onChange={(event) => setService(event.target.value)}
            maxLength={100}
            placeholder="checkout-api"
          />
        </Field>

        <Field label="Error signature" hint="Optional exact error text to match.">
          <input
            className="input"
            value={errorSignature}
            onChange={(event) => setErrorSignature(event.target.value)}
            maxLength={500}
            placeholder="connection pool exhausted"
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Window start" hint="Optional. Local time.">
          <input
            type="datetime-local"
            className="input"
            value={windowStart}
            onChange={(event) => setWindowStart(event.target.value)}
          />
        </Field>

        <Field label="Window end" hint="Optional. Must be after the start.">
          <input
            type="datetime-local"
            className="input"
            value={windowEnd}
            onChange={(event) => setWindowEnd(event.target.value)}
          />
        </Field>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="mono-label text-on-surface-variant">Source types</legend>
        <p className="font-body text-body-sm text-outline">
          Leave all unchecked to search every source type.
        </p>
        <div className="flex flex-wrap gap-3">
          {SOURCE_TYPES.map((source) => (
            <label
              key={source.value}
              className="flex items-center gap-1.5 font-body text-body-sm text-on-surface"
            >
              <input
                type="checkbox"
                checked={sourceTypes.includes(source.value)}
                onChange={() => toggleSourceType(source.value)}
              />
              {source.label}
            </label>
          ))}
        </div>
      </fieldset>

      {mode === 'create' ? (
        <label className="flex items-start gap-2 rounded border border-line bg-surface-low px-2.5 py-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={collectEvidence}
            onChange={(event) => setCollectEvidence(event.target.checked)}
          />
          <span>
            <span className="block font-label-lg text-label-lg text-on-surface">
              Collect evidence after creating
            </span>
            <span className="block font-body text-body-sm text-outline">
              Runs the same retrieval as the detail page. If retrieval fails, the
              investigation is still created and the failure is reported.
            </span>
          </span>
        </label>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={submitting}>
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
              ? 'Create investigation'
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
