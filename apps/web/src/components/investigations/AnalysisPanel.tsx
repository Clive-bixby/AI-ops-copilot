import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import { hypothesisTone } from '../../lib/investigation';
import type {
  ActionItemSuggestion,
  AnalysisHypothesis,
  HypothesisStatus,
  InvestigationAnalysis,
} from '../../lib/types';
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  InlineError,
  LoadingState,
} from '../ui';

function HypothesisCard({
  hypothesis,
  disabled,
  busy,
  onVerdict,
  onTrack,
}: {
  hypothesis: AnalysisHypothesis;
  disabled: boolean;
  busy: boolean;
  onVerdict: (status: HypothesisStatus) => void;
  onTrack?: (suggestion: ActionItemSuggestion) => void;
}) {
  return (
    <div className="rounded border border-line bg-surface-low p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={hypothesisTone(hypothesis.status)}>{hypothesis.status}</Badge>
        <span className="font-mono text-label-sm text-outline">
          {hypothesis.statusSource === 'user'
            ? 'verdict by a person'
            : 'proposed by the model'}
        </span>
      </div>
      <p className="mt-1.5 font-body text-body-md font-medium text-on-surface">
        {hypothesis.statement}
      </p>
      <p className="mt-1 font-body text-body-sm text-on-surface-variant">
        {hypothesis.rationale}
      </p>
      {hypothesis.verificationSteps.length > 0 ? (
        <div className="mt-2">
          <div className="mono-label text-outline">How to verify</div>
          <ul className="mt-1 space-y-1 font-body text-body-sm text-on-surface-variant">
            {hypothesis.verificationSteps.map((step) => (
              <li key={step} className="flex items-start gap-2">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-outline" />
                <span className="min-w-0 flex-1">{step}</span>
                {onTrack ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="add_task"
                    disabled={disabled}
                    title="Review and create an action item from this suggestion"
                    onClick={() =>
                      onTrack({
                        title: step,
                        sourceAnalysisId: hypothesis.analysisId,
                        sourceHypothesisId: hypothesis.id,
                        sourceLabel: step,
                      })
                    }
                  >
                    Track
                  </Button>
                ) : null}
              </li>
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

      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
        <span className="mono-label mr-auto text-outline">
          {hypothesis.status === 'unverified'
            ? 'Unverified — not a confirmed root cause'
            : 'Human verdict recorded'}
        </span>
        <Button
          size="sm"
          variant="secondary"
          icon="check"
          disabled={disabled || busy}
          onClick={() => onVerdict('supported')}
        >
          Support
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon="close"
          disabled={disabled || busy}
          onClick={() => onVerdict('rejected')}
        >
          Reject
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="undo"
          disabled={disabled || busy}
          onClick={() => onVerdict('unverified')}
        >
          Unverify
        </Button>
      </div>
    </div>
  );
}

export function AnalysisPanel({
  investigationId,
  analysis,
  hypotheses,
  closed,
  loading,
  onChanged,
  onCreateActionItem,
}: {
  investigationId: string;
  analysis: InvestigationAnalysis | null;
  hypotheses: AnalysisHypothesis[];
  closed: boolean;
  loading: boolean;
  onChanged: () => Promise<void>;
  onCreateActionItem?: (suggestion: ActionItemSuggestion) => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyHypothesis, setBusyHypothesis] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);

    try {
      await api.investigations.analyze(investigationId);
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRunning(false);
    }
  };

  const setVerdict = async (hypothesisId: string, status: HypothesisStatus) => {
    setBusyHypothesis(hypothesisId);
    setError(null);

    try {
      await api.investigations.updateHypothesis(investigationId, hypothesisId, status);
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyHypothesis(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-label-sm text-outline">
          {analysis
            ? `last run ${relativeTime(analysis.createdAt)} · ${analysis.provider} · ${analysis.model}`
            : 'no analysis run yet'}
        </span>
        <Button
          size="sm"
          variant="ai"
          icon="auto_awesome"
          className="ml-auto"
          onClick={() => void run()}
          disabled={closed || running || loading}
        >
          {running ? 'Analyzing…' : analysis ? 'Run analysis again' : 'Run analysis'}
        </Button>
      </div>

      {closed ? (
        <p className="rounded border border-line bg-surface-low px-2.5 py-2 font-body text-body-sm text-outline">
          A closed investigation can only be reopened; analysis is not run on it.
        </p>
      ) : null}

      {error ? <InlineError message={error} /> : null}

      {running ? (
        <div className="rounded border border-ai-border bg-ai-surface px-3 py-2">
          <LoadingState label="Analyzing the stored evidence. This can take a moment." />
        </div>
      ) : null}

      {loading && !analysis ? (
        <LoadingState label="Loading the latest analysis…" />
      ) : !analysis ? (
        <EmptyState
          compact
          icon="neurology"
          title="No analysis stored"
          description="Analysis is started explicitly and never simulated. Collect evidence first, then run it."
        />
      ) : analysis.status === 'failed' ? (
        <InlineError
          message={
            analysis.failureReason ??
            'The last analysis run failed. It is recorded so it is not mistaken for a result.'
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={analysis.insufficientEvidence ? 'warn' : 'ok'}>
              {analysis.insufficientEvidence ? 'insufficient evidence' : 'analysis stored'}
            </Badge>
            <span className="font-mono text-label-sm text-outline">
              {relativeTime(analysis.createdAt)}
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
              <p className="font-body text-[11px] text-outline">
                Suggestions only. Tracking one opens a form; you review and create
                the action item yourself.
              </p>
              <ol className="mt-1 space-y-1 font-body text-body-sm text-on-surface-variant">
                {analysis.nextSteps.map((step) => (
                  <li key={step} className="flex items-start gap-2">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-outline" />
                    <span className="min-w-0 flex-1">{step}</span>
                    {onCreateActionItem ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="add_task"
                        disabled={closed}
                        title="Review and create an action item from this suggestion"
                        onClick={() =>
                          onCreateActionItem({
                            title: step,
                            sourceAnalysisId: analysis.id,
                            sourceHypothesisId: null,
                            sourceLabel: step,
                          })
                        }
                      >
                        Track
                      </Button>
                    ) : null}
                  </li>
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
        </>
      )}

      <div className="border-t border-line pt-2">
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <span className="mono-label text-outline">Hypotheses</span>
          <span className="font-mono text-label-sm text-outline">
            not root causes unless a person verifies them
          </span>
        </div>
        {hypotheses.length === 0 ? (
          <p className="font-body text-body-sm text-outline">
            No hypotheses recorded yet.
          </p>
        ) : (
          <div className="space-y-2">
            {hypotheses.map((hypothesis) => (
              <HypothesisCard
                key={hypothesis.id}
                hypothesis={hypothesis}
                disabled={closed}
                busy={busyHypothesis === hypothesis.id}
                onVerdict={(status) => void setVerdict(hypothesis.id, status)}
                onTrack={onCreateActionItem}
              />
            ))}
          </div>
        )}
      </div>

      {running ? (
        <p className="flex items-center gap-1.5 font-body text-body-sm text-outline">
          <Icon name="sync" size={14} className="animate-spin" />
          The request is synchronous; this panel waits for the stored result.
        </p>
      ) : null}
    </div>
  );
}
