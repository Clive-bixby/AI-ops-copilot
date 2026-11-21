import { textMatchesSignature } from "./evidencePolicy.js";
import type { InvestigationSourceType } from "./policy.js";
import type {
  Investigation,
  InvestigationActivity,
  InvestigationEvidenceItem,
  InvestigationTimeline,
  TimelineCorrelation,
  TimelineEvent,
  TimelineEventKind,
} from "./types.js";

/**
 * The investigation timeline is composed, not stored: activity rows record what
 * the team did, and evidence rows carry the time of the thing that happened.
 * Merging them needs rules, and the rules live here so they can be tested and
 * explained without a database or a model.
 */

export const TIMELINE_LIMITS = {
  /** Oldest events are dropped past this cap; the summary says so. */
  maxEvents: 200,
  /** Enough activity history that the event cap, not the query, is the limit. */
  activityFetchLimit: 500,
  /** Evidence closer together than this is reported as one time cluster. */
  clusterWindowMinutes: 30,
} as const;

const ACTIVITY_TITLES: Record<
  Exclude<TimelineEventKind, "evidence_source">,
  string
> = {
  created: "Investigation created",
  note: "Note added",
  status_change: "Status changed",
  severity_change: "Severity changed",
  evidence_added: "Evidence added",
  evidence_removed: "Evidence removed",
  hypothesis_created: "Hypothesis created",
  hypothesis_status: "Hypothesis updated",
  analysis_started: "Analysis started",
  analysis_succeeded: "Analysis finished",
  analysis_failed: "Analysis failed",
  follow_up: "Follow-up question",
};

const CORRELATIONS: readonly TimelineCorrelation[] = [
  "signature_match",
  "same_service",
  "in_window",
  "before_window",
  "after_window",
  "time_cluster",
];

function ms(value: string): number {
  return new Date(value).getTime();
}

function readService(metadata: Record<string, unknown> | null): string | null {
  if (metadata === null) {
    return null;
  }

  const value = metadata.service;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Single-linkage clustering of evidence timestamps. Only sources that carry
 * their own timestamp take part, and a singleton is never labelled a cluster.
 */
function clusterEvidence(
  evidence: InvestigationEvidenceItem[],
  windowMs: number
): Set<string> {
  const dated = evidence
    .filter(
      (item): item is InvestigationEvidenceItem & { sourceCreatedAt: string } =>
        item.sourceCreatedAt !== null
    )
    .map((item) => ({ id: item.id, at: ms(item.sourceCreatedAt) }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  const clustered = new Set<string>();
  let group: Array<{ id: string; at: number }> = [];

  const flush = (): void => {
    if (group.length >= 2) {
      for (const item of group) {
        clustered.add(item.id);
      }
    }
    group = [];
  };

  for (const item of dated) {
    const previous = group[group.length - 1];
    if (previous && item.at - previous.at > windowMs) {
      flush();
    }
    group.push(item);
  }

  flush();

  return clustered;
}

function evidenceCorrelations(input: {
  evidence: InvestigationEvidenceItem;
  investigation: Investigation;
  clustered: Set<string>;
}): TimelineCorrelation[] {
  const { evidence, investigation, clustered } = input;
  const correlations: TimelineCorrelation[] = [];

  if (
    textMatchesSignature(
      `${evidence.sourceTitle}\n${evidence.excerpt}`,
      investigation.errorSignature
    )
  ) {
    correlations.push("signature_match");
  }

  const service = readService(evidence.sourceMetadata);
  if (
    service !== null &&
    investigation.service !== null &&
    service.toLowerCase() === investigation.service.trim().toLowerCase()
  ) {
    correlations.push("same_service");
  }

  if (evidence.sourceCreatedAt !== null) {
    const at = ms(evidence.sourceCreatedAt);
    const beforeWindow =
      investigation.windowStart !== null && at < ms(investigation.windowStart);
    const afterWindow =
      investigation.windowEnd !== null && at > ms(investigation.windowEnd);

    if (beforeWindow) {
      correlations.push("before_window");
    } else if (afterWindow) {
      correlations.push("after_window");
    } else if (
      investigation.windowStart !== null ||
      investigation.windowEnd !== null
    ) {
      correlations.push("in_window");
    }
  }

  if (clustered.has(evidence.id)) {
    correlations.push("time_cluster");
  }

  return correlations;
}

function activityEvent(entry: InvestigationActivity): TimelineEvent {
  return {
    id: `activity:${entry.id}`,
    kind: entry.type,
    at: entry.createdAt,
    atSourceTime: false,
    title: ACTIVITY_TITLES[entry.type],
    detail: entry.body,
    activityId: entry.id,
    evidenceId: null,
    sourceType: null,
    sourceId: null,
    relevance: null,
    actorEmail: entry.actorEmail,
    correlations: [],
  };
}

function evidenceEvent(
  evidence: InvestigationEvidenceItem,
  correlations: TimelineCorrelation[]
): TimelineEvent {
  return {
    id: `evidence:${evidence.id}`,
    kind: "evidence_source",
    at: evidence.sourceCreatedAt ?? evidence.createdAt,
    atSourceTime: evidence.sourceCreatedAt !== null,
    title: evidence.sourceTitle,
    detail: evidence.inclusionReason,
    activityId: null,
    evidenceId: evidence.id,
    sourceType: evidence.sourceType,
    sourceId: evidence.sourceId,
    relevance: evidence.relevance,
    actorEmail: null,
    correlations,
  };
}

/**
 * Chronological order, with a deterministic tie-break: at the same instant the
 * team's own action comes before the source event it relates to, and then id
 * order decides. Two calls with the same data always produce the same timeline.
 */
function compareEvents(a: TimelineEvent, b: TimelineEvent): number {
  const diff = ms(a.at) - ms(b.at);
  if (diff !== 0) {
    return diff;
  }

  const aIsEvidence = a.kind === "evidence_source";
  const bIsEvidence = b.kind === "evidence_source";
  if (aIsEvidence !== bIsEvidence) {
    return aIsEvidence ? 1 : -1;
  }

  return a.id.localeCompare(b.id);
}

export function buildTimeline(input: {
  investigation: Investigation;
  activity: InvestigationActivity[];
  evidence: InvestigationEvidenceItem[];
  now: string;
  maxEvents?: number;
  clusterWindowMinutes?: number;
}): InvestigationTimeline {
  const maxEvents = input.maxEvents ?? TIMELINE_LIMITS.maxEvents;
  const clusterWindowMinutes =
    input.clusterWindowMinutes ?? TIMELINE_LIMITS.clusterWindowMinutes;

  const clustered = clusterEvidence(
    input.evidence,
    clusterWindowMinutes * 60_000
  );

  const events = [
    ...input.activity.map(activityEvent),
    ...input.evidence.map((item) =>
      evidenceEvent(
        item,
        evidenceCorrelations({
          evidence: item,
          investigation: input.investigation,
          clustered,
        })
      )
    ),
  ].sort(compareEvents);

  const clipped = events.length > maxEvents;
  const kept = clipped ? events.slice(events.length - maxEvents) : events;

  const bySourceType: Record<InvestigationSourceType, number> = {
    document: 0,
    log: 0,
    ticket: 0,
  };
  const correlations = Object.fromEntries(
    CORRELATIONS.map((label) => [label, 0])
  ) as Record<TimelineCorrelation, number>;

  let undated = 0;
  for (const item of input.evidence) {
    bySourceType[item.sourceType] += 1;
    if (item.sourceCreatedAt === null) {
      undated += 1;
    }
  }

  for (const event of kept) {
    for (const label of event.correlations) {
      correlations[label] += 1;
    }
  }

  return {
    investigationId: input.investigation.id,
    windowStart: input.investigation.windowStart,
    windowEnd: input.investigation.windowEnd,
    generatedAt: input.now,
    events: kept,
    summary: {
      total: kept.length,
      clipped,
      undated,
      evidence: input.evidence.length,
      activity: input.activity.length,
      bySourceType,
      correlations,
    },
  };
}
