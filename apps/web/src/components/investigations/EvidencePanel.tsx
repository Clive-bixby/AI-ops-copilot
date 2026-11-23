import { useState } from 'react';
import clsx from 'clsx';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, relativeTime, titleCase } from '../../lib/format';
import { relevanceTone, sourceLabel } from '../../lib/investigation';
import type {
  EvidenceCollectionSummary,
  InvestigationEvidenceItem,
  InvestigationSourceType,
} from '../../lib/types';
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  Field,
  Icon,
  InlineError,
} from '../ui';

function EvidenceItem({
  item,
  canEdit,
  onUnlink,
}: {
  item: InvestigationEvidenceItem;
  canEdit: boolean;
  onUnlink: (item: InvestigationEvidenceItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <article className="border-b border-line px-md py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge
          tone="neutral"
          icon={
            item.sourceType === 'log'
              ? 'terminal'
              : item.sourceType === 'ticket'
                ? 'confirmation_number'
                : 'description'
          }
        >
          {sourceLabel(item.sourceType)}
        </Badge>
        <Badge tone={relevanceTone(item.relevance)}>{titleCase(item.relevance)}</Badge>
        {item.origin === 'manual' ? <Badge tone="ai">Linked by hand</Badge> : null}
        <span className="ml-auto font-mono text-label-sm text-outline">
          {item.sourceCreatedAt
            ? formatDateTime(item.sourceCreatedAt)
            : 'no source timestamp'}
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
          {item.similarity === null
            ? 'similarity —'
            : `similarity ${item.similarity.toFixed(2)}`}
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
            <dd className="mt-0.5 font-body text-body-sm text-on-surface">
              {item.inclusionReason}
            </dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <dt className="mono-label text-outline">Retrieved by</dt>
            <dd className="font-mono text-code-sm text-on-surface-variant">
              {item.retrievalQuery}
            </dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <dt className="mono-label text-outline">Source id</dt>
            <dd className="font-mono text-code-sm text-on-surface-variant">
              {item.sourceId}
            </dd>
            <CopyButton value={item.sourceId} label="Copy" />
          </div>
        </dl>
      ) : null}

      {canEdit ? (
        <div className="mt-2 flex justify-end border-t border-line pt-2">
          <Button
            variant="ghost"
            size="sm"
            icon="link_off"
            onClick={() => onUnlink(item)}
          >
            Unlink evidence
          </Button>
        </div>
      ) : null}
    </article>
  );
}

export function EvidencePanel({
  investigationId,
  evidence,
  lastCollection,
  closed,
  onChanged,
}: {
  investigationId: string;
  evidence: InvestigationEvidenceItem[];
  lastCollection: EvidenceCollectionSummary | null;
  closed: boolean;
  onChanged: () => Promise<void>;
}) {
  const [collecting, setCollecting] = useState(false);
  const [linking, setLinking] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [sourceType, setSourceType] = useState<InvestigationSourceType>('ticket');
  const [sourceId, setSourceId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [collection, setCollection] = useState<EvidenceCollectionSummary | null>(
    lastCollection
  );

  const collect = async () => {
    setCollecting(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await api.investigations.collectEvidence(investigationId);
      setCollection(result.collection ?? null);
      setSuccess(
        result.collection
          ? `Collection finished: ${result.collection.added} added, ${result.collection.existing} already present.`
          : 'Collection finished.'
      );
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setCollecting(false);
    }
  };

  const link = async () => {
    setLinking(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await api.investigations.linkEvidence(investigationId, {
        sourceType,
        sourceId: sourceId.trim(),
        reason: reason.trim() || null,
      });
      setSuccess(
        result.added
          ? 'Source linked as evidence.'
          : 'That source was already part of the evidence set.'
      );
      setSourceId('');
      setReason('');
      setShowLink(false);
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLinking(false);
    }
  };

  const unlink = async (item: InvestigationEvidenceItem) => {
    if (
      !window.confirm(
        `Unlink "${item.sourceTitle}" from this investigation? The source itself is not deleted.`
      )
    ) {
      return;
    }

    setError(null);
    setSuccess(null);

    try {
      await api.investigations.unlinkEvidence(investigationId, item.id);
      setSuccess('Evidence unlinked.');
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const manualCount = evidence.filter((item) => item.origin === 'manual').length;
  const collectedCount = evidence.length - manualCount;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-md py-2">
        <span className="font-mono text-label-sm text-outline">
          {collectedCount} collected · {manualCount} linked by hand
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            icon="add_link"
            onClick={() => setShowLink((current) => !current)}
            disabled={closed || collecting}
          >
            {showLink ? 'Close link form' : 'Link source'}
          </Button>
          <Button
            size="sm"
            icon="travel_explore"
            onClick={() => void collect()}
            disabled={closed || collecting}
          >
            {collecting ? 'Collecting…' : 'Collect evidence'}
          </Button>
        </div>
      </div>

      {closed ? (
        <p className="border-b border-line bg-surface-low px-md py-2 font-body text-body-sm text-outline">
          A closed investigation can only be reopened; evidence cannot be changed.
        </p>
      ) : null}

      {error ? (
        <div className="px-md pt-2">
          <InlineError message={error} />
        </div>
      ) : null}
      {success ? (
        <div className="mx-md mt-2 flex items-center gap-1.5 rounded border border-success-line bg-success-surface px-2.5 py-1.5 font-body text-body-sm text-success-ink">
          <Icon name="check_circle" size={14} /> {success}
        </div>
      ) : null}

      {showLink && !closed ? (
        <div className="space-y-2 border-b border-line bg-surface-low px-md py-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Source type">
              <select
                className="select"
                value={sourceType}
                onChange={(event) =>
                  setSourceType(event.target.value as InvestigationSourceType)
                }
              >
                <option value="ticket">Ticket</option>
                <option value="document">Document</option>
                <option value="log">Log group</option>
              </select>
            </Field>
            <Field label="Source id" hint="The id of an existing source in this organization.">
              <input
                className="input"
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </Field>
          </div>
          <Field label="Reason" hint="Optional. Recorded with the evidence.">
            <input
              className="input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              placeholder="Quoted in the war room"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setShowLink(false)}
              disabled={linking}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              icon="link"
              onClick={() => void link()}
              disabled={linking || sourceId.trim().length === 0}
            >
              {linking ? 'Linking…' : 'Link evidence'}
            </Button>
          </div>
        </div>
      ) : null}

      {collection ? (
        <div className="border-b border-line bg-surface-low px-md py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono-label text-outline">Last collection</span>
            <Badge tone={collection.failed ? 'critical' : 'ok'}>
              {collection.failed ? 'failed' : 'completed'}
            </Badge>
            <span className="font-mono text-label-sm text-outline">
              {collection.added} added · {collection.existing} existing ·{' '}
              {collection.filteredOut} filtered out · {collection.withheld} withheld
            </span>
          </div>
          {collection.queries.length > 0 ? (
            <p className="mt-1 font-mono text-label-sm text-outline">
              queries: {collection.queries.join(' · ')}
            </p>
          ) : null}
          {collection.warnings.length > 0 ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 font-body text-body-sm text-warning-ink">
              {collection.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 font-body text-[11px] text-outline">
            Weak candidates are withheld from automatic collection; they can still be
            linked manually.
          </p>
        </div>
      ) : null}

      {evidence.length === 0 ? (
        <EmptyState
          compact
          icon="inventory_2"
          title="No evidence collected"
          description="Collection stores direct, historical and related evidence. If nothing qualified, the investigation stays legitimately empty rather than showing weak matches."
        />
      ) : (
        <div>
          {evidence.map((item) => (
            <EvidenceItem
              key={item.id}
              item={item}
              canEdit={!closed}
              onUnlink={(entry) => void unlink(entry)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
