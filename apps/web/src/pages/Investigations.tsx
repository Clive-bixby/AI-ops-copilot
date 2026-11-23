import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { useApiData, useDebouncedValue } from '../lib/hooks';
import { relativeTime, shortId, titleCase } from '../lib/format';
import {
  INVESTIGATION_SEVERITIES,
  INVESTIGATION_STATUSES,
  investigationStatusTone,
  ownerLabel,
  severityTone,
} from '../lib/investigation';
import type {
  CreateInvestigationInput,
  Investigation,
  InvestigationList,
  InvestigationSeverity,
  InvestigationStatus,
} from '../lib/types';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  InlineError,
  LoadingState,
  Modal,
  PageHeader,
  Pagination,
  Panel,
} from '../components/ui';
import { InvestigationForm } from '../components/investigations/InvestigationForm';

const PAGE_SIZE = 20;

function InvestigationRow({
  investigation,
  onOpen,
}: {
  investigation: Investigation;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 border-b border-line px-md py-3 text-left transition-colors last:border-b-0 hover:bg-surface-low"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={investigationStatusTone(investigation.status)}>
          {investigation.status}
        </Badge>
        <Badge tone={severityTone(investigation.severity)}>{investigation.severity}</Badge>
        {investigation.service ? (
          <Badge tone="neutral" icon="layers">
            {investigation.service}
          </Badge>
        ) : null}
        <span className="ml-auto font-mono text-label-sm text-outline">
          updated {relativeTime(investigation.updatedAt)}
        </span>
      </div>

      <span className="font-label-lg text-label-lg font-semibold text-on-surface">
        {investigation.title}
      </span>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-label-sm text-outline">
        <span>INV-{shortId(investigation.id, 6)}</span>
        <span className={clsx(investigation.ownerUserId ? '' : 'text-warning-ink')}>
          owner {ownerLabel(investigation)}
        </span>
        {investigation.windowStart && investigation.windowEnd ? (
          <span>window recorded</span>
        ) : (
          <span>no window</span>
        )}
        <span className="ml-auto flex items-center gap-1 font-label-lg text-label-lg font-semibold text-primary">
          Open <Icon name="arrow_forward" size={13} />
        </span>
      </div>
    </button>
  );
}

export function Investigations() {
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 180);
  const [status, setStatus] = useState<InvestigationStatus | 'all'>('all');
  const [severity, setSeverity] = useState<InvestigationSeverity | 'all'>('all');
  const [owner, setOwner] = useState('all');
  const [page, setPage] = useState(1);

  const listState = useApiData<InvestigationList>(
    () =>
      api.investigations.list({
        status: status === 'all' ? undefined : status,
        severity: severity === 'all' ? undefined : severity,
        owner: owner === 'all' ? undefined : owner,
        q: debouncedQuery.trim() || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
    [status, severity, owner, debouncedQuery, page]
  );

  const membersState = useApiData(() => api.organization.members(), []);

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const investigations = listState.data?.investigations ?? [];
  const total = listState.data?.total ?? 0;

  const resetFilters = () => {
    setQuery('');
    setStatus('all');
    setSeverity('all');
    setOwner('all');
    setPage(1);
  };

  const createInvestigation = async (payload: CreateInvestigationInput) => {
    setCreating(true);
    setCreateError(null);

    try {
      const result = await api.investigations.create(payload);
      setCreateOpen(false);
      navigate(`/investigations/${result.investigation.id}`);
    } catch (error) {
      setCreateError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <>
            <span className="eyebrow">Operations cockpit</span>
            <span className="h-1 w-1 rounded-full bg-outline" />
            <span className="font-mono text-label-sm uppercase tracking-wider text-primary">
              Investigation queue
            </span>
            <Badge tone="neutral">{total} recorded</Badge>
          </>
        }
        title="Investigations"
        description="Every investigation recorded for this organization. Open one to collect evidence, run an analysis, record a note or change its lifecycle."
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon="refresh"
              onClick={() => void listState.reload()}
              disabled={listState.loading}
            >
              Refresh
            </Button>
            <Button size="sm" icon="add" onClick={() => setCreateOpen(true)}>
              New investigation
            </Button>
          </>
        }
      />

      {listState.error && !listState.data ? (
        <ErrorState message={listState.error} onRetry={() => void listState.reload()} />
      ) : (
        <Panel
          title="Queue"
          icon="troubleshoot"
          meta={`${investigations.length} shown of ${total}`}
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
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="Search title or problem statement…"
                aria-label="Search investigations"
                className="input pl-8"
              />
            </div>

            <div className="grid gap-1.5 sm:grid-cols-3">
              <select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as InvestigationStatus | 'all');
                  setPage(1);
                }}
                aria-label="Filter by status"
                className="select"
              >
                <option value="all">Status: all</option>
                {INVESTIGATION_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {titleCase(value)}
                  </option>
                ))}
              </select>

              <select
                value={severity}
                onChange={(event) => {
                  setSeverity(event.target.value as InvestigationSeverity | 'all');
                  setPage(1);
                }}
                aria-label="Filter by severity"
                className="select"
              >
                <option value="all">Severity: all</option>
                {INVESTIGATION_SEVERITIES.map((value) => (
                  <option key={value} value={value}>
                    {titleCase(value)}
                  </option>
                ))}
              </select>

              <select
                value={owner}
                onChange={(event) => {
                  setOwner(event.target.value);
                  setPage(1);
                }}
                aria-label="Filter by owner"
                className="select"
              >
                <option value="all">Owner: anyone</option>
                <option value="me">Owner: me</option>
                <option value="unassigned">Owner: unassigned</option>
                {(membersState.data?.members ?? []).map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.email}
                  </option>
                ))}
              </select>
            </div>

            {membersState.error ? (
              <p className="font-body text-body-sm text-warning-ink">
                Member directory unavailable: {membersState.error}. Owner filters for
                specific people are hidden, but the API still enforces assignment.
              </p>
            ) : null}

            {status !== 'all' || severity !== 'all' || owner !== 'all' || query ? (
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" icon="filter_alt_off" onClick={resetFilters}>
                  Reset filters
                </Button>
              </div>
            ) : null}
          </div>

          {listState.loading && !listState.data ? (
            <LoadingState label="Loading investigations…" />
          ) : listState.error ? (
            <div className="p-md">
              <InlineError
                message={listState.error}
                onRetry={() => void listState.reload()}
              />
            </div>
          ) : investigations.length === 0 ? (
            <EmptyState
              icon="troubleshoot"
              title={total === 0 ? 'No investigations recorded' : 'No investigations match these filters'}
              description={
                total === 0
                  ? 'Create the first investigation to record a problem statement and start collecting evidence.'
                  : 'Widen the text, status, severity or owner filters.'
              }
              action={
                total === 0 ? (
                  <Button size="sm" icon="add" onClick={() => setCreateOpen(true)}>
                    New investigation
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={resetFilters}>
                    Reset filters
                  </Button>
                )
              }
            />
          ) : (
            <div>
              {investigations.map((investigation) => (
                <InvestigationRow
                  key={investigation.id}
                  investigation={investigation}
                  onOpen={() => navigate(`/investigations/${investigation.id}`)}
                />
              ))}
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                total={total}
                onPage={setPage}
                label="investigations"
              />
            </div>
          )}
        </Panel>
      )}

      <Modal
        open={createOpen}
        onClose={() => {
          if (creating) return;
          setCreateOpen(false);
          setCreateError(null);
        }}
        title="New investigation"
        description="Record a problem statement. Ownership defaults to you in this form; the backend stores unassigned if no owner is sent."
        width="max-w-3xl"
      >
        <InvestigationForm
          mode="create"
          members={membersState.data?.members ?? []}
          membersLoading={membersState.loading}
          submitting={creating}
          error={createError}
          onSubmit={(payload) => void createInvestigation(payload as CreateInvestigationInput)}
          onCancel={() => {
            if (creating) return;
            setCreateOpen(false);
            setCreateError(null);
          }}
        />
      </Modal>
    </div>
  );
}
