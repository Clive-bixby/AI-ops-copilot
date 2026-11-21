import { pool } from "../../core/db.js";
import { buildExcerpt, sourceKey } from "./evidencePolicy.js";
import type { ResolvedEvidenceSource } from "./evidencePolicy.js";
import type { InvestigationSourceType } from "./policy.js";

/**
 * Resolve `source_chunks.source_id` back to the real source row.
 *
 * Retrieval only knows a polymorphic id. Evidence must not trust it: a source can
 * have been deleted since it was indexed, and the id could belong to another
 * organization. Every lookup here is scoped by organization, and a missing row is
 * reported as unresolved rather than turned into invented evidence.
 */

type DocumentSourceRow = {
  id: string;
  filename: string;
  content: string | null;
  created_at: Date | string | null;
};

type TicketSourceRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  created_at: Date | string | null;
};

type LogGroupSourceRow = {
  id: string;
  level: string;
  service: string | null;
  template: string;
  event_count: number;
  window_start: Date | string;
  window_end: Date | string;
  first_seen: Date | string;
  last_seen: Date | string;
  sample_content: string | null;
};

export type EvidenceSourceRef = {
  sourceType: InvestigationSourceType;
  sourceId: string;
};

function toIso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

export function renderLogGroup(source: LogGroupSourceRow): string {
  const windowStart = toIso(source.window_start) ?? "unknown";
  const windowEnd = toIso(source.window_end) ?? "unknown";

  return [
    `Log group: level=${source.level}${source.service ? ` service=${source.service}` : ""}`,
    `Window: ${windowStart} to ${windowEnd}`,
    `Events: ${source.event_count}`,
    `Template: ${source.template}`,
    source.sample_content ? `Sample events:\n${source.sample_content}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function renderTicket(source: TicketSourceRow): string {
  return [
    `Ticket: ${source.title}`,
    `Priority: ${source.priority}`,
    `Status: ${source.status}`,
    source.description ?? "",
  ]
    .filter((line) => line.trim() !== "")
    .join("\n");
}

/**
 * Resolve many refs with at most three queries (one per source type).
 */
export async function resolveEvidenceSources(
  organizationId: string,
  refs: EvidenceSourceRef[]
): Promise<Map<string, ResolvedEvidenceSource>> {
  const resolved = new Map<string, ResolvedEvidenceSource>();
  const documentIds = new Set<string>();
  const ticketIds = new Set<string>();
  const logGroupIds = new Set<string>();

  for (const ref of refs) {
    if (ref.sourceType === "document") {
      documentIds.add(ref.sourceId);
    } else if (ref.sourceType === "ticket") {
      ticketIds.add(ref.sourceId);
    } else {
      logGroupIds.add(ref.sourceId);
    }
  }

  if (documentIds.size > 0) {
    const rows = await pool.query<DocumentSourceRow>(
      `SELECT id, filename, content, created_at
       FROM documents
       WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [organizationId, [...documentIds]]
    );

    for (const row of rows.rows) {
      resolved.set(sourceKey("document", row.id), {
        sourceType: "document",
        sourceId: row.id,
        sourceTitle: row.filename,
        // The stored document body is only a fallback for a manual link; a
        // retrieved document uses the chunk that actually matched.
        excerpt: buildExcerpt(row.content ?? row.filename),
        sourceCreatedAt: toIso(row.created_at),
        service: null,
        status: null,
        metadata: { filename: row.filename, kind: "document" },
      });
    }
  }

  if (ticketIds.size > 0) {
    const rows = await pool.query<TicketSourceRow>(
      `SELECT id, title, description, status, priority, created_at
       FROM tickets
       WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [organizationId, [...ticketIds]]
    );

    for (const row of rows.rows) {
      resolved.set(sourceKey("ticket", row.id), {
        sourceType: "ticket",
        sourceId: row.id,
        sourceTitle: row.title,
        excerpt: buildExcerpt(renderTicket(row)),
        sourceCreatedAt: toIso(row.created_at),
        service: null,
        status: row.status,
        metadata: {
          kind: "ticket",
          status: row.status,
          priority: row.priority,
        },
      });
    }
  }

  if (logGroupIds.size > 0) {
    const rows = await pool.query<LogGroupSourceRow>(
      `SELECT id, level, service, template, event_count,
              window_start, window_end, first_seen, last_seen, sample_content
       FROM log_groups
       WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [organizationId, [...logGroupIds]]
    );

    for (const row of rows.rows) {
      resolved.set(sourceKey("log", row.id), {
        sourceType: "log",
        sourceId: row.id,
        sourceTitle: truncate(row.template, 300),
        excerpt: buildExcerpt(renderLogGroup(row)),
        // A log group's canonical time is the start of its window; the evidence
        // timeline labels it that way instead of pretending it is one event.
        sourceCreatedAt: toIso(row.window_start),
        service: row.service,
        status: null,
        metadata: {
          kind: "log",
          level: row.level,
          service: row.service,
          eventCount: row.event_count,
          windowStart: toIso(row.window_start),
          windowEnd: toIso(row.window_end),
          firstSeen: toIso(row.first_seen),
          lastSeen: toIso(row.last_seen),
        },
      });
    }
  }

  return resolved;
}

export async function resolveEvidenceSource(
  organizationId: string,
  ref: EvidenceSourceRef
): Promise<ResolvedEvidenceSource | null> {
  const resolved = await resolveEvidenceSources(organizationId, [ref]);

  return resolved.get(sourceKey(ref.sourceType, ref.sourceId)) ?? null;
}
