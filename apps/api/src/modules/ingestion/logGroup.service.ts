import { pool } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { embedTexts } from "./embed.service.js";
import { getEmbeddingConfig, hashContent } from "./embeddingConfig.js";
import { IngestionValidationError, SourceNotFoundError } from "./errors.js";
import { replaceSourceIndex } from "./sourceIndex.service.js";

export const LOG_GROUP_WINDOW_MINUTES = 15;

/**
 * Only actionable levels are embedded. Info/debug lines are high volume and
 * near-identical, and embedding them spends the index budget on noise that
 * never answers an operational question.
 */
const NOTABLE_LEVELS = new Set(["warn", "error", "fatal"]);
const MAX_EVENTS_PER_CALL = 5000;
const MAX_GROUPS_PER_CALL = 500;
const SAMPLE_LIMIT = 5;
const SAMPLE_MESSAGE_MAX_CHARS = 300;

export type LogGroupingResult = {
  eventsReceived: number;
  eventsGrouped: number;
  eventsSkipped: number;
  groupIds: string[];
};

export type LogIndexResult = {
  groupsIndexed: number;
  groupsSkipped: number;
};

type LogEventRow = {
  id: string;
  level: string;
  message: string;
  metadata: Record<string, unknown> | null;
  timestamp: Date | string;
};

type PendingGroup = {
  level: string;
  service: string | null;
  template: string;
  templateHash: string;
  windowStart: Date;
  windowEnd: Date;
  firstSeen: Date;
  lastSeen: Date;
  eventCount: number;
  sampleLogIds: string[];
  samples: string[];
};

type GroupRow = {
  id: string;
  level: string;
  service: string | null;
  template: string;
  window_start: Date | string;
  window_end: Date | string;
  event_count: number;
  sample_content: string | null;
};

/**
 * Normalise a log message into a template by replacing the parts that vary
 * between occurrences of the same event: ids, timestamps, addresses, and
 * numbers. Case is preserved for display; grouping compares the hashed template.
 */
export function normalizeLogMessage(message: string): string {
  return message
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "{uuid}"
    )
    .replace(/\b[0-9a-f]{16,}\b/gi, "{hex}")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "{timestamp}")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "{ip}")
    .replace(/https?:\/\/\S+/gi, "{url}")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "{email}")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h|kb|mb|gb|%)\b/gi, "{number}")
    .replace(/\b\d+\b/g, "{number}")
    .replace(/\s+/g, " ")
    .trim();
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new IngestionValidationError("Log has an invalid timestamp");
  }

  return date;
}

function floorWindow(date: Date): Date {
  const sizeMs = LOG_GROUP_WINDOW_MINUTES * 60 * 1000;
  return new Date(Math.floor(date.getTime() / sizeMs) * sizeMs);
}

function extractService(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) {
    return null;
  }

  for (const key of ["service", "app", "component", "logger", "source"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 100);
    }
  }

  return null;
}

function buildGroupChunk(row: GroupRow): string {
  const windowStart = toDate(row.window_start).toISOString();
  const windowEnd = toDate(row.window_end).toISOString();

  return [
    `Log group: level=${row.level}${row.service ? ` service=${row.service}` : ""}`,
    `Window: ${windowStart} to ${windowEnd}`,
    `Events: ${row.event_count}`,
    `Template: ${row.template}`,
    row.sample_content ? `Sample events:\n${row.sample_content}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function upsertGroup(group: PendingGroup, organizationId: string): Promise<GroupRow> {
  const result = await pool.query<GroupRow>(
    `
    INSERT INTO log_groups (
      organization_id, level, service, template, template_hash,
      window_start, window_end, event_count, first_seen, last_seen,
      sample_log_ids, sample_content, embedding_status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid[], $12, 'pending')
    ON CONFLICT (organization_id, level, COALESCE(service, ''), template_hash, window_start)
    DO UPDATE SET
      event_count = log_groups.event_count + EXCLUDED.event_count,
      first_seen = LEAST(log_groups.first_seen, EXCLUDED.first_seen),
      last_seen = GREATEST(log_groups.last_seen, EXCLUDED.last_seen),
      sample_log_ids = EXCLUDED.sample_log_ids,
      sample_content = EXCLUDED.sample_content,
      embedding_status = 'pending',
      updated_at = NOW()
    RETURNING id, level, service, template, window_start, window_end,
              event_count, sample_content
    `,
    [
      organizationId,
      group.level,
      group.service,
      group.template,
      group.templateHash,
      group.windowStart,
      group.windowEnd,
      group.eventCount,
      group.firstSeen,
      group.lastSeen,
      group.sampleLogIds,
      group.samples.join("\n"),
    ]
  );

  const row = result.rows[0];
  if (!row) {
    throw new IngestionValidationError("Failed to store log group");
  }

  return row;
}

/**
 * Store the grouped representation of notable log events.
 *
 * Grouping is deterministic: the identity (org, level, service, template hash,
 * window) means a re-ingest of the same window updates the same group. No
 * embedding happens here, so this step stays cheap enough to run inside the
 * ingest request; embedding is enqueued as one job per touched group.
 */
export async function groupLogEvents(input: {
  organizationId: string;
  logIds: string[];
}): Promise<LogGroupingResult> {
  const organizationId = (input.organizationId || "").trim();
  if (!organizationId) {
    throw new IngestionValidationError("Organization ID is required");
  }

  const logIds = [...new Set((input.logIds ?? []).filter(Boolean))];
  if (logIds.length === 0) {
    throw new IngestionValidationError("At least one log id is required");
  }

  if (logIds.length > MAX_EVENTS_PER_CALL) {
    throw new IngestionValidationError(
      `At most ${MAX_EVENTS_PER_CALL} log events can be grouped per call`
    );
  }

  const events = await pool.query<LogEventRow>(
    `SELECT id, level, message, metadata, timestamp
     FROM logs
     WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [organizationId, logIds]
  );

  const groups = new Map<string, PendingGroup>();
  let eventsGrouped = 0;
  let eventsSkipped = 0;

  for (const event of events.rows) {
    const level = (event.level || "info").toLowerCase();
    if (!NOTABLE_LEVELS.has(level)) {
      eventsSkipped += 1;
      continue;
    }

    eventsGrouped += 1;
    const timestamp = toDate(event.timestamp);
    const template = normalizeLogMessage(event.message);
    const service = extractService(event.metadata);
    const windowStart = floorWindow(timestamp);
    const windowEnd = new Date(
      windowStart.getTime() + LOG_GROUP_WINDOW_MINUTES * 60 * 1000
    );
    const templateHash = hashContent(template.toLowerCase());
    const key = `${level}|${service ?? ""}|${templateHash}|${windowStart.toISOString()}`;

    const existing = groups.get(key);
    if (existing) {
      existing.eventCount += 1;
      existing.firstSeen = new Date(
        Math.min(existing.firstSeen.getTime(), timestamp.getTime())
      );
      existing.lastSeen = new Date(
        Math.max(existing.lastSeen.getTime(), timestamp.getTime())
      );
      if (existing.sampleLogIds.length < SAMPLE_LIMIT) {
        existing.sampleLogIds.push(event.id);
        existing.samples.push(
          event.message.slice(0, SAMPLE_MESSAGE_MAX_CHARS)
        );
      }
      continue;
    }

    groups.set(key, {
      level,
      service,
      template,
      templateHash,
      windowStart,
      windowEnd,
      firstSeen: timestamp,
      lastSeen: timestamp,
      eventCount: 1,
      sampleLogIds: [event.id],
      samples: [event.message.slice(0, SAMPLE_MESSAGE_MAX_CHARS)],
    });
  }

  const groupIds: string[] = [];
  for (const group of groups.values()) {
    const row = await upsertGroup(group, organizationId);
    groupIds.push(row.id);
  }

  logger.info("ingestion.logs_grouped", {
    organizationId,
    eventsReceived: events.rows.length,
    eventsGrouped,
    eventsSkipped,
    groupsTouched: groupIds.length,
  });

  return {
    eventsReceived: events.rows.length,
    eventsGrouped,
    eventsSkipped,
    groupIds,
  };
}

/**
 * Embed and index stored log groups, one chunk per group.
 *
 * `sample_log_ids` keeps a citation traceable to real rows; the group is a
 * retrieval representation, never a replacement for the evidence.
 */
export async function indexLogGroups(input: {
  organizationId: string;
  groupIds: string[];
}): Promise<LogIndexResult> {
  const organizationId = (input.organizationId || "").trim();
  if (!organizationId) {
    throw new IngestionValidationError("Organization ID is required");
  }

  const groupIds = [...new Set((input.groupIds ?? []).filter(Boolean))];
  if (groupIds.length === 0) {
    throw new IngestionValidationError("At least one log group id is required");
  }

  if (groupIds.length > MAX_GROUPS_PER_CALL) {
    throw new IngestionValidationError(
      `At most ${MAX_GROUPS_PER_CALL} log groups can be indexed per call`
    );
  }

  const result = await pool.query<GroupRow>(
    `SELECT id, level, service, template, window_start, window_end,
            event_count, sample_content
     FROM log_groups
     WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [organizationId, groupIds]
  );

  if (result.rows.length === 0) {
    throw new SourceNotFoundError("Log group not found");
  }

  const config = getEmbeddingConfig();
  let groupsIndexed = 0;

  for (const row of result.rows) {
    const content = buildGroupChunk(row);

    try {
      const [embedding] = await embedTexts([content]);
      if (!embedding) {
        throw new IngestionValidationError("Log group embedding was not produced");
      }

      await replaceSourceIndex({
        organizationId,
        sourceType: "log",
        sourceId: row.id,
        sourceCreatedAt: row.window_start,
        chunks: [
          {
            index: 0,
            content,
            chunkHash: hashContent(content),
            metadata: {
              sourceType: "log",
              sourceId: row.id,
              level: row.level,
              service: row.service,
              eventCount: row.event_count,
              windowStart: toDate(row.window_start).toISOString(),
              windowEnd: toDate(row.window_end).toISOString(),
              sampleLogIds: [],
            },
          },
        ],
        embeddings: [embedding.embedding],
        config,
      });

      await pool.query(
        `UPDATE log_groups SET embedding_status = 'indexed' WHERE id = $1 AND organization_id = $2`,
        [row.id, organizationId]
      );

      groupsIndexed += 1;
    } catch (error) {
      logger.error("ingestion.log_group_failed", {
        organizationId,
        groupId: row.id,
        error,
      });

      await pool.query(
        `UPDATE log_groups SET embedding_status = 'failed' WHERE id = $1 AND organization_id = $2`,
        [row.id, organizationId]
      );

      throw error;
    }
  }

  logger.info("ingestion.log_groups_indexed", {
    organizationId,
    groupsRequested: groupIds.length,
    groupsIndexed,
  });

  return {
    groupsIndexed,
    groupsSkipped: groupIds.length - result.rows.length,
  };
}

/**
 * Convenience path used by tests and one-shot callers: group, then index the
 * groups that were touched.
 */
export async function indexLogEvents(input: {
  organizationId: string;
  logIds: string[];
}): Promise<LogGroupingResult & LogIndexResult> {
  const grouped = await groupLogEvents(input);
  const indexed =
    grouped.groupIds.length > 0
      ? await indexLogGroups({
          organizationId: input.organizationId,
          groupIds: grouped.groupIds,
        })
      : { groupsIndexed: 0, groupsSkipped: 0 };

  return { ...grouped, ...indexed };
}
