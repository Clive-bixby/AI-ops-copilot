import { pool } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { hashLogEvent } from "../ingestion/embeddingConfig.js";
import { enqueueIngestionJob } from "../ingestion/jobQueue.js";
import { groupLogEvents } from "../ingestion/logGroup.service.js";
import { LogParseError, parseRawLogs } from "./log.parser.js";

type StoredLogRow = {
  id: string;
  organization_id: string;
  level: string;
  message: string;
  metadata: Record<string, unknown> | null;
  timestamp: string;
  created_at: string;
};

type LogGroupRow = {
  id: string;
  level: string;
  service: string | null;
  template: string;
  window_start: string;
  window_end: string;
  event_count: number;
  first_seen: string;
  last_seen: string;
  sample_log_ids: string[];
  sample_content: string | null;
  embedding_status: string;
};

export class LogsValidationError extends Error {}
export { LogParseError };

export type IngestLogsResult = {
  logs: Array<{
    id: string;
    organizationId: string;
    level: string;
    message: string;
    metadata: Record<string, unknown>;
    timestamp: string;
    createdAt: string;
  }>;
  /** Duplicate events already stored for this organization. */
  duplicates: number;
  groupsTouched: number;
  jobsQueued: number;
  /** Set when the rows were stored but grouping or queueing failed. */
  indexingError: string | null;
};

export async function ingestLogs(
  organizationId: string,
  payload: unknown
): Promise<IngestLogsResult> {
  const orgId = (organizationId || "").trim();
  if (!orgId) {
    throw new LogsValidationError("Organization ID is required");
  }

  const normalizedLogs = parseRawLogs(payload);

  // One multi-row INSERT for the whole batch instead of a statement per row:
  // a 1000-entry payload used to mean 1000 round trips inside a transaction.
  const values: unknown[] = [];
  const placeholders: string[] = [];

  normalizedLogs.forEach((log, index) => {
    const base = index * 6;
    values.push(
      orgId,
      log.level,
      log.message,
      log.metadata,
      log.timestamp,
      hashLogEvent(log)
    );
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`
    );
  });

  const result = await pool.query<StoredLogRow>(
    `
    INSERT INTO logs (organization_id, level, message, metadata, timestamp, content_hash)
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (organization_id, content_hash) WHERE content_hash IS NOT NULL
    DO NOTHING
    RETURNING id, organization_id, level, message, metadata, timestamp, created_at
    `,
    values
  );

  const stored = result.rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    level: row.level,
    message: row.message,
    metadata: row.metadata || {},
    timestamp: row.timestamp,
    createdAt: row.created_at,
  }));

  let groupsTouched = 0;
  let jobsQueued = 0;
  let indexingError: string | null = null;

  if (stored.length > 0) {
    try {
      // Grouping is deterministic and cheap; embedding is the expensive part and
      // runs in the worker, one job per touched group.
      const grouped = await groupLogEvents({
        organizationId: orgId,
        logIds: stored.map((row) => row.id),
      });
      groupsTouched = grouped.groupIds.length;

      for (const groupId of grouped.groupIds) {
        try {
          await enqueueIngestionJob({
            organizationId: orgId,
            sourceType: "log",
            sourceId: groupId,
          });
          jobsQueued += 1;
        } catch (error) {
          indexingError =
            error instanceof Error ? error.message : "Could not queue indexing";
          logger.error("ingestion.log_group_enqueue_failed", {
            organizationId: orgId,
            groupId,
            error,
          });
        }
      }
    } catch (error) {
      indexingError =
        error instanceof Error ? error.message : "Could not group logs";
      logger.error("ingestion.log_grouping_failed", {
        organizationId: orgId,
        error,
      });
    }
  }

  return {
    logs: stored,
    duplicates: normalizedLogs.length - stored.length,
    groupsTouched,
    jobsQueued,
    indexingError,
  };
}

export async function listLogs(organizationId: string) {
  const result = await pool.query<StoredLogRow>(
    `SELECT id, organization_id, level, message, metadata, timestamp, created_at
     FROM logs
     WHERE organization_id = $1
     ORDER BY timestamp DESC
     LIMIT 100`,
    [organizationId]
  );
  return result.rows;
}

export async function getLogGroup(
  organizationId: string,
  groupId: string
): Promise<{
  group: LogGroupRow;
  sampleLogs: Array<{
    id: string;
    level: string;
    message: string;
    timestamp: string;
  }>;
} | null> {
  const result = await pool.query<LogGroupRow>(
    `SELECT id, level, service, template, window_start, window_end, event_count,
            first_seen, last_seen, sample_log_ids, sample_content, embedding_status
     FROM log_groups
     WHERE id = $1 AND organization_id = $2`,
    [groupId, organizationId]
  );

  const group = result.rows[0];
  if (!group) {
    return null;
  }

  const samples = await pool.query<{
    id: string;
    level: string;
    message: string;
    timestamp: string;
  }>(
    `SELECT id, level, message, timestamp
     FROM logs
     WHERE organization_id = $1 AND id = ANY($2::uuid[])
     ORDER BY timestamp ASC`,
    [organizationId, group.sample_log_ids]
  );

  return { group, sampleLogs: samples.rows };
}
