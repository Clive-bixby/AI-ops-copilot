import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useApiData } from '../lib/hooks';
import { formatNumber } from '../lib/format';
import type { OperationsOverview } from '../lib/types';
import { Icon, Skeleton } from './ui';

/**
 * A compact operational strip for the command center.
 *
 * The counts come from `GET /insights/operations`, the same endpoint the
 * Operations page renders, so the dashboard cannot drift from the detailed view.
 */
export function OperationsStrip() {
  const { data, loading, error, reload } = useApiData<OperationsOverview>(
    () => api.insights.operations(),
    []
  );

  const cells = data
    ? [
        {
          label: 'Open investigations',
          value: data.investigations.open + data.investigations.investigating,
          icon: 'radar',
          tone: '',
        },
        {
          label: 'Unassigned',
          value: data.investigations.unassigned,
          icon: 'person_alert',
          tone: data.investigations.unassigned > 0 ? 'text-critical-ink' : '',
        },
        {
          label: 'Overdue items',
          value: data.actionItems.summary.overdue,
          icon: 'schedule',
          tone: data.actionItems.summary.overdue > 0 ? 'text-critical-ink' : '',
        },
        {
          label: `Due in ${data.dueSoonHours}h`,
          value: data.actionItems.summary.dueSoon,
          icon: 'timer',
          tone: '',
        },
      ]
    : [];

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-low px-md py-2.5">
        <div className="flex items-center gap-2">
          <Icon name="dashboard" size={16} className="text-outline" />
          <h2 className="font-headline-sm text-headline-sm text-on-surface">
            Operational load
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {error ? (
            <button
              onClick={() => void reload()}
              className="font-label-lg text-label-lg font-semibold text-critical-ink underline underline-offset-2"
            >
              Retry
            </button>
          ) : null}
          <Link
            to="/operations"
            className="flex items-center gap-1 font-label-lg text-label-lg font-semibold text-primary"
          >
            Open operations <Icon name="arrow_forward" size={14} />
          </Link>
        </div>
      </div>

      {error && !data ? (
        <p className="px-md py-3 font-body text-body-sm text-critical-ink">
          Operational counts unavailable: {error}
        </p>
      ) : loading && !data ? (
        <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="bg-surface p-md">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-2 h-6 w-12" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-4">
          {cells.map((cell) => (
            <div key={cell.label} className="bg-surface p-md">
              <div className="flex items-center justify-between gap-2">
                <span className="mono-label text-outline">{cell.label}</span>
                <Icon name={cell.icon} size={15} className="text-outline" />
              </div>
              <div
                className={`mt-1 font-headline-md text-headline-md font-bold tabular ${
                  cell.tone || 'text-on-surface'
                }`}
              >
                {formatNumber(cell.value)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
