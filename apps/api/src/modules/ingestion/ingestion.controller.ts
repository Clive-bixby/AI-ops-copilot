import { pool } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { readWorkerHeartbeat, WORKER_HEARTBEAT_TTL_SECONDS } from "../../core/queue.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import { resolveStaleJobMs } from "./jobRecovery.js";
import {
  enqueueIngestionJob,
  getIngestionJob,
  getIngestionLedgerSnapshot,
  getIngestionQueueSnapshot,
  listIngestionJobs,
} from "./jobQueue.js";
import type { IngestionJobStatus } from "./jobQueue.js";
import type { SourceType } from "./sourceIndex.service.js";

const MAX_REINDEX_SOURCES = 200;
const MAX_JOB_PAGE = 100;

const SOURCE_TYPES: SourceType[] = ["document", "log", "ticket"];
const JOB_STATUSES: IngestionJobStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
];

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readSingle(value: unknown): string {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }

  return typeof value === "string" ? value : "";
}

export const listIngestionJobsController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const rawStatus = readSingle(req.query.status);
  if (rawStatus && !JOB_STATUSES.includes(rawStatus as IngestionJobStatus)) {
    throw createHttpError(400, "Unsupported job status filter");
  }

  const rawSourceType = readSingle(req.query.sourceType);
  if (rawSourceType && !SOURCE_TYPES.includes(rawSourceType as SourceType)) {
    throw createHttpError(400, "Unsupported source type filter");
  }

  const rawLimit = readSingle(req.query.limit);
  const limit = rawLimit ? Number(rawLimit) : 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_JOB_PAGE) {
    throw createHttpError(400, `limit must be an integer between 1 and ${MAX_JOB_PAGE}`);
  }

  const jobs = await listIngestionJobs({
    organizationId,
    limit,
    ...(rawStatus ? { status: rawStatus as IngestionJobStatus } : {}),
    ...(rawSourceType ? { sourceType: rawSourceType as SourceType } : {}),
  });

  return res.status(200).json({ total: jobs.length, jobs });
});

export const getIngestionJobController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const rawId = req.params.id;
  const jobId = Array.isArray(rawId) ? rawId[0] ?? "" : rawId ?? "";
  if (!UUID_REGEX.test(jobId)) {
    throw createHttpError(400, "A valid job ID is required");
  }

  const job = await getIngestionJob(organizationId, jobId);
  if (!job) {
    throw createHttpError(404, "Ingestion job not found");
  }

  return res.status(200).json(job);
});

/**
 * One read for "is ingestion working right now".
 *
 * Answering that used to require three places: the job list (which only shows
 * this tenant's rows), Redis (is anything queued?), and the container logs (is a
 * worker alive?). A stuck `running` row looked identical to a slow one, and a
 * dead worker looked like an empty queue.
 *
 * Redis failures are reported as `queue.available: false` instead of failing the
 * endpoint: when ingestion is broken, this is the endpoint you are calling.
 */
export const ingestionHealthController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const staleAfterMs = resolveStaleJobMs();
  const jobs = await getIngestionLedgerSnapshot(organizationId, staleAfterMs);

  let queue: { available: boolean; counts?: Record<string, number> } = {
    available: false,
  };
  let worker: { status: "up" | "stale" | "missing" | "unknown"; lastHeartbeatSecondsAgo: number | null } = {
    status: "unknown",
    lastHeartbeatSecondsAgo: null,
  };

  try {
    const [counts, heartbeat] = await Promise.all([
      getIngestionQueueSnapshot(),
      readWorkerHeartbeat(),
    ]);

    queue = { available: true, counts: { ...counts } };

    if (heartbeat === null) {
      worker = { status: "missing", lastHeartbeatSecondsAgo: null };
    } else {
      const ageSeconds = Math.max(0, Math.round((Date.now() - heartbeat) / 1000));
      worker = {
        status:
          ageSeconds <= WORKER_HEARTBEAT_TTL_SECONDS ? "up" : "stale",
        lastHeartbeatSecondsAgo: ageSeconds,
      };
    }
  } catch (error) {
    logger.warn("ingestion.health_redis_unavailable", {
      organizationId,
      error,
    });
  }

  return res
    .status(200)
    .set("Cache-Control", "no-store")
    .json({
      generatedAt: new Date().toISOString(),
      staleAfterSeconds: Math.round(staleAfterMs / 1000),
      jobs,
      queue,
      worker,
    });
});

/**
 * Enqueue indexing for every stored source of the requested types.
 *
 * Bounded per call: a reindex request is a maintenance action, not a way to
 * create an unbounded queue in one HTTP request. Repeating the request advances
 * through the remaining sources because unchanged sources are skipped by the
 * processors, and active jobs are deduplicated by the ledger.
 */
export const reindexController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const rawTypes = (req.body as { sourceTypes?: unknown })?.sourceTypes;
  let sourceTypes: SourceType[] = SOURCE_TYPES;

  if (rawTypes !== undefined) {
    if (!Array.isArray(rawTypes) || rawTypes.length === 0) {
      throw createHttpError(400, "sourceTypes must be a non-empty array");
    }

    sourceTypes = [];
    for (const entry of rawTypes) {
      if (typeof entry !== "string" || !SOURCE_TYPES.includes(entry as SourceType)) {
        throw createHttpError(400, `Unsupported source type '${String(entry)}'`);
      }
      if (!sourceTypes.includes(entry as SourceType)) {
        sourceTypes.push(entry as SourceType);
      }
    }
  }

  const sources: Array<{ sourceType: SourceType; sourceId: string }> = [];

  for (const sourceType of sourceTypes) {
    const table =
      sourceType === "document"
        ? "documents"
        : sourceType === "ticket"
          ? "tickets"
          : "log_groups";

    const result = await pool.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE organization_id = $1 ORDER BY created_at ASC LIMIT $2`,
      [organizationId, MAX_REINDEX_SOURCES - sources.length]
    );

    for (const row of result.rows) {
      sources.push({ sourceType, sourceId: row.id });
    }

    if (sources.length >= MAX_REINDEX_SOURCES) {
      break;
    }
  }

  let enqueued = 0;
  let deduplicated = 0;
  let failed = 0;

  for (const source of sources) {
    try {
      const result = await enqueueIngestionJob({
        organizationId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
      });
      if (result.created) {
        enqueued += 1;
      } else {
        deduplicated += 1;
      }
    } catch (error) {
      failed += 1;
      logger.error("ingestion.reindex_enqueue_failed", {
        organizationId,
        ...source,
        error,
      });
    }
  }

  logger.info("ingestion.reindex_requested", {
    organizationId,
    requested: sources.length,
    enqueued,
    deduplicated,
    failed,
  });

  return res.status(202).json({
    requested: sources.length,
    enqueued,
    deduplicated,
    failed,
    sourceTypes,
    cappedAt: MAX_REINDEX_SOURCES,
  });
});
