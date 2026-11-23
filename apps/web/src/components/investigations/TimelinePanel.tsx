import { formatDateTime, titleCase } from '../../lib/format';
import { correlationLabel, relevanceTone } from '../../lib/investigation';
import type { InvestigationTimeline } from '../../lib/types';
import { Badge } from '../ui';

export function TimelinePanel({ timeline }: { timeline: InvestigationTimeline }) {
  if (timeline.events.length === 0) {
    return (
      <p className="px-md py-6 text-center font-body text-body-sm text-outline">
        No timeline events yet. Evidence and activity appear here as they are recorded.
      </p>
    );
  }

  return (
    <div className="max-h-[460px] overflow-y-auto">
      <ol className="divide-y divide-line">
        {timeline.events.map((event) => (
          <li key={event.id} className="flex gap-3 px-md py-2">
            <div className="w-[132px] shrink-0">
              <div className="font-mono text-label-sm text-on-surface">
                {formatDateTime(event.at)}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-outline">
                {event.atSourceTime ? 'source time' : 'recorded'}
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-label-lg text-label-lg text-on-surface">
                  {event.title}
                </span>
                {event.relevance ? (
                  <Badge tone={relevanceTone(event.relevance)}>
                    {titleCase(event.relevance)}
                  </Badge>
                ) : null}
                {event.correlations.map((correlation) => (
                  <span
                    key={correlation}
                    className="rounded border border-outline-variant px-1 font-mono text-[10px] uppercase tracking-wider text-outline"
                  >
                    {correlationLabel(correlation)}
                  </span>
                ))}
              </div>
              {event.detail ? (
                <p className="mt-0.5 line-clamp-2 font-body text-body-sm text-on-surface-variant">
                  {event.detail}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {timeline.summary.clipped ? (
        <p className="border-t border-line px-md py-2 font-body text-body-sm text-outline">
          Older events were clipped to keep this timeline readable.
        </p>
      ) : null}
    </div>
  );
}
