import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { ALLOWED_STATUS_TRANSITIONS } from '../../lib/investigation';
import type { Investigation, InvestigationStatus } from '../../lib/types';
import { Button, Field, Icon, InlineError, Modal } from '../ui';

/**
 * Labels are verbs because these buttons change the lifecycle, not a filter.
 * The backend validates every transition; this map only mirrors the policy so a
 * button that cannot succeed is not offered.
 */
const ACTION_LABEL: Record<InvestigationStatus, string> = {
  open: 'Reopen as open',
  investigating: 'Start investigating',
  resolved: 'Resolve',
  closed: 'Close',
};

const ACTION_ICON: Record<InvestigationStatus, string> = {
  open: 'lock_open',
  investigating: 'play_arrow',
  resolved: 'task_alt',
  closed: 'archive',
};

export function StatusControls({
  investigation,
  onChanged,
}: {
  investigation: Investigation;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<InvestigationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolutionSummary, setResolutionSummary] = useState(
    investigation.resolutionSummary ?? ''
  );
  const [resolutionError, setResolutionError] = useState<string | null>(null);

  const targets = ALLOWED_STATUS_TRANSITIONS[investigation.status] ?? [];

  const changeStatus = async (
    status: InvestigationStatus,
    summary?: string
  ) => {
    setBusy(status);
    setError(null);
    setSuccess(null);

    try {
      await api.investigations.update(investigation.id, {
        status,
        // Only a resolution carries a summary; sending null elsewhere would
        // either be rejected or clear a field the user did not edit.
        ...(summary !== undefined ? { resolutionSummary: summary } : {}),
        expectedUpdatedAt: investigation.updatedAt,
      });

      setSuccess(`Status changed to ${status}.`);
      setResolving(false);
      await onChanged();
    } catch (caught) {
      const message = errorMessage(caught);
      if (resolving) {
        setResolutionError(message);
      } else {
        setError(message);
      }
    } finally {
      setBusy(null);
    }
  };

  const submitResolution = () => {
    const summary = resolutionSummary.trim();

    if (summary.length < 10) {
      setResolutionError('A resolution summary must be at least 10 characters.');
      return;
    }

    if (summary.length > 2000) {
      setResolutionError('A resolution summary must be no more than 2000 characters.');
      return;
    }

    setResolutionError(null);
    void changeStatus('resolved', summary);
  };

  const onAction = (target: InvestigationStatus) => {
    if (target === 'resolved') {
      setResolutionError(null);
      setResolving(true);
      return;
    }

    if (
      target === 'closed' &&
      !window.confirm(
        'Close this investigation? Its statement becomes read-only; it can still be reopened later.'
      )
    ) {
      return;
    }

    void changeStatus(target);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mono-label mr-1 text-outline">Lifecycle</span>
        {targets.length === 0 ? (
          <span className="font-body text-body-sm text-outline">
            No transitions are available.
          </span>
        ) : (
          targets.map((target) => (
            <Button
              key={target}
              size="sm"
              variant={target === 'closed' ? 'secondary' : 'primary'}
              icon={ACTION_ICON[target]}
              disabled={busy !== null}
              onClick={() => onAction(target)}
            >
              {busy === target ? 'Working…' : ACTION_LABEL[target]}
            </Button>
          ))
        )}
      </div>

      {investigation.status === 'resolved' ? (
        <p className="font-body text-body-sm text-outline">
          Resolved. Closing keeps the resolution time; reopening clears the summary and
          records what it said in the activity history.
        </p>
      ) : null}

      {investigation.status === 'closed' ? (
        <p className="flex items-start gap-1.5 font-body text-body-sm text-outline">
          <Icon name="info" size={14} className="mt-0.5" />
          A closed investigation can only be reopened. Its statement cannot be edited.
        </p>
      ) : null}

      {error ? <InlineError message={error} /> : null}
      {success ? (
        <p className="flex items-center gap-1.5 rounded border border-success-line bg-success-surface px-2.5 py-1.5 font-body text-body-sm text-success-ink">
          <Icon name="check_circle" size={14} /> {success}
        </p>
      ) : null}

      <Modal
        open={resolving}
        onClose={() => {
          if (busy) return;
          setResolving(false);
          setResolutionError(null);
        }}
        title="Resolve investigation"
        description="Record what was actually found and how it was confirmed. Resolving does not close the investigation or complete any action items."
        width="max-w-2xl"
        footer={
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => {
                setResolving(false);
                setResolutionError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              icon="task_alt"
              disabled={busy !== null}
              onClick={submitResolution}
            >
              {busy === 'resolved' ? 'Resolving…' : 'Resolve'}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          {resolutionError ? <InlineError message={resolutionError} /> : null}
          <Field
            label="Resolution summary"
            hint="Facts only. What changed, how it was verified, and any follow-up that remains."
          >
            <textarea
              className="textarea min-h-[140px]"
              value={resolutionSummary}
              onChange={(event) => setResolutionSummary(event.target.value)}
              maxLength={2000}
            />
          </Field>
          <p className="font-body text-body-sm text-outline">
            This is stored as a human resolution, not a model claim. Analysis results
            remain separate and are never copied in automatically.
          </p>
        </div>
      </Modal>
    </div>
  );
}
