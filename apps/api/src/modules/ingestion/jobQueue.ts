import { pool } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { getIngestionQueue, pingRedis, withDeadline } from "../../core/queue.js";
import { getEmbeddingConfig } from "./embeddingConfig.js";
import type { SourceType } from "./sourceIndex.service.js";

export type IngestionJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export type IngestionJobRow = {
  id: string;
  organization_id: string;
  source_type: SourceType;
  source_id: string;
  status: IngestionJobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  embedding_config_hash: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const JOB_COLUMNS = `
  id, organization_id, source_type, source_id, status, attempts, max_attempts,
  last_error, embedding_config_hash, created_at, updated_at, started_at,
  finished_at
`;

export class QueueUnavailableError extends Error {
  constructor(message = "Ingestion queue is unavailable") {
    super(message);
    this.name = "QueueUnavailableError";
  }
}

export type EnqueueOptions = {
  organizationId: string;
  sourceType: SourceType;
  sourceId: string;
  /** Uploaded file path, shared by the api and worker containers. */
  filePath?: string;
};

/** Long enough for a slow managed Redis, short enough not to hang an upload. */
const DISPATCH_TIMEOUT_MS = 5_000;

export type DispatchPayload = {
  jobId: string;
  organizationId: string;
  sourceType: SourceType;
  sourceId: string;
  filePath?: string;
};

/**
 * Hand one already-recorded job to BullMQ.
 *
 * Separate from `enqueueIngestionJob` because the recovery sweep dispatches a
 * row that exists but has no transport job (or lost it when the process died).
 * The ledger row is written first in both paths: Redis is transport, Postgres
 * is the truth.
 */
export async function dispatchIngestionJob(
  payload: DispatchPayload
): Promise<void> {
  // Probe first, with a throwaway connection and a hard deadline. `add` resolves
  // the queue's Redis connection before it sends anything, so against an
  // unreachable Redis it never settles: the upload hung instead of reporting
  // that it could not be queued. Building the BullMQ client at all in that state
  // also leaves an internal connection promise that rejects later with nobody
  // left to handle it, which exits the process.
  await pingRedis();

  await withDeadline(
    getIngestionQueue().add(
      "ingest",
      payload,
      // The ledger id doubles as the queue id, so a redelivery or a recovery
      // attempt collapses onto the job that is already queued instead of
      // starting a second run for the same source.
      { jobId: payload.jobId }
    ),
    DISPATCH_TIMEOUT_MS
  );
}

/**
 * Record the intent to index a source, then hand the job id to BullMQ.
 *
 * The row is written first so a Redis outage cannot lose the fact that work was
 * requested. The partial unique index on active jobs makes duplicate
 * submissions return the job already in flight instead of creating a second
 * worker run for the same source.
 */
export async function enqueueIngestionJob(
  options: EnqueueOptions
): Promise<{ job: IngestionJobRow; created: boolean }> {
  const config = getEmbeddingConfig();

  const inserted = await pool.query<IngestionJobRow>(
    `
    INSERT INTO ingestion_jobs (
      organization_id, source_type, source_id, status, embedding_config_hash, file_path
    )
    VALUES ($1, $2, $3, 'queued', $4, $5)
    ON CONFLICT (organization_id, source_type, source_id)
      WHERE status IN ('queued', 'running')
    DO NOTHING
    RETURNING *
    `,
    [
      options.organizationId,
      options.sourceType,
      options.sourceId,
      config.hash,
      options.filePath ?? null,
    ]
  );

  let job = inserted.rows[0];
  const created = Boolean(job);

  if (!job) {
    const existing = await pool.query<IngestionJobRow>(
      `
      SELECT *
      FROM ingestion_jobs
      WHERE organization_id = $1
        AND source_type = $2
        AND source_id = $3
        AND status IN ('queued', 'running')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [options.organizationId, options.sourceType, options.sourceId]
    );

    job = existing.rows[0];
    if (!job) {
      throw new Error("Failed to record ingestion job");
    }
  }

  try {
    await dispatchIngestionJob({
      jobId: job.id,
      organizationId: options.organizationId,
      sourceType: options.sourceType,
      sourceId: options.sourceId,
      ...(options.filePath ? { filePath: options.filePath } : {}),
    });
  } catch (error) {
    logger.error("ingestion.enqueue_failed", {
      organizationId: options.organizationId,
      sourceType: options.sourceType,
      sourceId: options.sourceId,
      jobId: job.id,
      error,
    });

    await pool.query(
      `UPDATE ingestion_jobs
       SET status = 'failed',
           last_error = $2,
           finished_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND organization_id = $3`,
      [job.id, "Ingestion queue is unavailable", options.organizationId]
    );

    throw new QueueUnavailableError();
  }

  logger.info("ingestion.job_enqueued", {
    organizationId: options.organizationId,
    sourceType: options.sourceType,
    sourceId: options.sourceId,
    jobId: job.id,
    duplicateSubmission: !created,
  });

  return { job, created };
}

export async function listIngestionJobs(input: {
  organizationId: string;
  status?: IngestionJobStatus;
  sourceType?: SourceType;
  limit: number;
}): Promise<IngestionJobRow[]> {
  const conditions = ["organization_id = $1"];
  const values: unknown[] = [input.organizationId];

  if (input.status) {
    values.push(input.status);
    conditions.push(`status = $${values.length}`);
  }

  if (input.sourceType) {
    values.push(input.sourceType);
    conditions.push(`source_type = $${values.length}`);
  }

  values.push(input.limit);

  // Explicit columns: `file_path` is a server-side detail. `SELECT *` started
  // returning it once the recovery migration added the column, which would have
  // published upload paths inside the container to any API client.
  const result = await pool.query<IngestionJobRow>(
    `SELECT ${JOB_COLUMNS} FROM ingestion_jobs
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${values.length}`,
    values
  );

  return result.rows;
}

export async function getIngestionJob(
  organizationId: string,
  jobId: string
): Promise<IngestionJobRow | null> {
  const result = await pool.query<IngestionJobRow>(
    `SELECT ${JOB_COLUMNS} FROM ingestion_jobs
     WHERE id = $1 AND organization_id = $2`,
    [jobId, organizationId]
  );

  return result.rows[0] ?? null;
}

export type IngestionJobCounts = Record<IngestionJobStatus, number>;

export type IngestionLedgerSnapshot = {
  counts: IngestionJobCounts;
  total: number;
  /** Rows still marked `running` past the stale threshold. */
  stuckRunning: number;
  /** Age of the oldest job still waiting for a worker, in seconds. */
  oldestQueuedSeconds: number | null;
};

/**
 * What the ledger says about this tenant's ingestion backlog.
 *
 * `stuckRunning` is the number the recovery sweep exists for: a non-zero value
 * means jobs died with the process. It is computed with the same threshold the
 * sweep uses, so the dashboard and the sweeper cannot disagree.
 */
export async function getIngestionLedgerSnapshot(
  organizationId: string,
  staleAfterMs: number
): Promise<IngestionLedgerSnapshot> {
  const result = await pool.query<{
    status: IngestionJobStatus;
    count: number;
    stuck: number;
    oldest_queued: Date | null;
  }>(
    `SELECT status,
            COUNT(*)::int AS count,
            COUNT(*) FILTER (
              WHERE status = 'running'
                AND updated_at < NOW() - ($2::int * INTERVAL '1 millisecond')
            )::int AS stuck,
            MIN(created_at) FILTER (WHERE status = 'queued') AS oldest_queued
     FROM ingestion_jobs
     WHERE organization_id = $1
     GROUP BY status`,
    [organizationId, staleAfterMs]
  );

  const counts: IngestionJobCounts = {
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  let stuckRunning = 0;
  let oldestQueued: Date | null = null;

  for (const row of result.rows) {
    counts[row.status] = Number(row.count ?? 0);
    stuckRunning += Number(row.stuck ?? 0);

    if (row.oldest_queued && (!oldestQueued || row.oldest_queued < oldestQueued)) {
      oldestQueued = row.oldest_queued;
    }
  }

  return {
    counts,
    total: Object.values(counts).reduce((sum, value) => sum + value, 0),
    stuckRunning,
    oldestQueuedSeconds: oldestQueued
      ? Math.max(0, Math.round((Date.now() - oldestQueued.getTime()) / 1000))
      : null,
  };
}

export type IngestionQueueSnapshot = {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
};

/** A BullMQ command against a dead Redis must not outlive the request. */
const QUEUE_COUNTS_TIMEOUT_MS = 2_000;

/**
 * Depth of the transport queue. Throws when Redis is unreachable.
 *
 * The probe runs first for the same reason as in `dispatchIngestionJob`: while
 * Redis is down `getJobCounts()` waits for a connection that never arrives, so
 * the health endpoint would hang exactly when it is needed -- and the unused
 * BullMQ client would outlive the request as a rejected promise.
 */
export async function getIngestionQueueSnapshot(): Promise<IngestionQueueSnapshot> {
  await pingRedis();

  const counts = await withDeadline(
    getIngestionQueue().getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed",
      "completed"
    ),
    QUEUE_COUNTS_TIMEOUT_MS
  );

  return {
    waiting: Number(counts.waiting ?? 0),
    active: Number(counts.active ?? 0),
    delayed: Number(counts.delayed ?? 0),
    failed: Number(counts.failed ?? 0),
    completed: Number(counts.completed ?? 0),
  };
}
