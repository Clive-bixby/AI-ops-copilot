import fs from "node:fs/promises";

import { envInt } from "../../config/env.js";
import { pool } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { getIngestionQueue } from "../../core/queue.js";
import { dispatchIngestionJob } from "./jobQueue.js";
import type { SourceType } from "./sourceIndex.service.js";

/**
 * A job row is considered abandoned when it has not moved for this long.
 *
 * Ten minutes is deliberately longer than any single indexing run this app
 * performs (chunk + embed a document) and longer than BullMQ's stalled-job
 * window, so an ordinary transport retry is never mistaken for a crash.
 * INGESTION_STALE_JOB_MS=0 disables the sweeper.
 */
export const DEFAULT_STALE_JOB_MS = 10 * 60_000;

export function resolveStaleJobMs(): number {
  return envInt("INGESTION_STALE_JOB_MS", DEFAULT_STALE_JOB_MS);
}

export type RecoveryAction = "requeue" | "fail" | "ignore";

export type RecoverableJob = {
  status: string;
  attempts: number;
  maxAttempts: number;
  /** Last time the row changed; `updated_at`. */
  updatedAt: Date;
};

/**
 * Decide what to do with one job row, without touching the database.
 *
 * The three outcomes exist because a row can be stuck for different reasons:
 *
 *   queued   the API recorded the intent and then died before BullMQ accepted
 *            it, or Redis lost the job. Nothing will ever run it: requeue.
 *   running  the worker died mid-run. The ledger still says `running`, so a
 *            retry cannot tell it apart from real work in progress. Requeue
 *            while attempts remain, otherwise record it as failed.
 *   failed   terminal by design. A failed job is retried by reprocessing the
 *            source, which creates a new row with its own attempt budget; the
 *            sweeper must not resurrect it and silently spend embedding budget.
 */
export function classifyStaleJob(
  job: RecoverableJob,
  now: number,
  staleAfterMs: number
): RecoveryAction {
  if (job.status !== "running" && job.status !== "queued") {
    return "ignore";
  }

  const ageMs = now - job.updatedAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs < staleAfterMs) {
    return "ignore";
  }

  if (job.status === "queued") {
    return "requeue";
  }

  return job.attempts < job.maxAttempts ? "requeue" : "fail";
}

type StuckJobRow = {
  id: string;
  organization_id: string;
  source_type: SourceType;
  source_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  file_path: string | null;
  updated_at: Date;
};

export type RecoverySummary = {
  scanned: number;
  requeued: number;
  failed: number;
  skipped: number;
};

/** Only hand over an upload path the file system still has. */
async function usableFilePath(filePath: string | null): Promise<string | undefined> {
  const candidate = (filePath || "").trim();
  if (!candidate) {
    return undefined;
  }

  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * Turn an abandoned `running` row into a terminal one.
 *
 * The document row needs the same treatment: `indexDocument` sets it to
 * `processing` before any embedding work, so a crash leaves the UI showing
 * "processing" forever with no job that could ever finish it.
 */
async function failInterruptedJob(job: StuckJobRow): Promise<void> {
  const message =
    `Interrupted after ${job.attempts} of ${job.max_attempts} attempts: ` +
    "the worker stopped before this job finished. Reprocess the source to try again.";

  await pool.query(
    `UPDATE ingestion_jobs
     SET status = 'failed', last_error = $3, finished_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND organization_id = $2 AND status = 'running'`,
    [job.id, job.organization_id, message]
  );

  if (job.source_type === "document") {
    await pool.query(
      `UPDATE documents
       SET processing_status = 'failed', processing_error = $3
       WHERE id = $1
         AND organization_id = $2
         AND processing_status IN ('pending', 'processing')`,
      [job.source_id, job.organization_id, message]
    );
  }

  logger.error("ingestion.job_abandoned", {
    jobId: job.id,
    organizationId: job.organization_id,
    sourceType: job.source_type,
    sourceId: job.source_id,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
  });
}

/**
 * Hand an abandoned row back to the transport.
 *
 * The BullMQ job id is reused, so the queue itself is the concurrency guard: a
 * job that is still waiting, delayed or active is left alone (the worker is
 * alive and just slow), and only a job that has left the queue entirely is
 * removed and re-added. Re-adding under a new id instead would let the same
 * source run twice at once and pay for the embeddings twice.
 */
async function requeueInterruptedJob(job: StuckJobRow): Promise<boolean> {
  try {
    const queue = getIngestionQueue();
    const existing = await queue.getJob(job.id);

    if (existing) {
      const state = await existing.getState();

      if (
        state === "active" ||
        state === "waiting" ||
        state === "delayed" ||
        state === "prioritized" ||
        state === "waiting-children"
      ) {
        logger.info("ingestion.recovery_transport_busy", {
          jobId: job.id,
          state,
        });
        return false;
      }

      // Left behind in the completed/failed set; the id must be free to re-add.
      await existing.remove();
    }

    const filePath = await usableFilePath(job.file_path);

    await dispatchIngestionJob({
      jobId: job.id,
      organizationId: job.organization_id,
      sourceType: job.source_type,
      sourceId: job.source_id,
      ...(filePath ? { filePath } : {}),
    });
  } catch (error) {
    // Leave the row as it is: the next sweep retries. Marking it failed here
    // would turn a Redis outage into permanently abandoned ingestion work.
    logger.error("ingestion.recovery_requeue_failed", {
      jobId: job.id,
      organizationId: job.organization_id,
      error,
    });
    return false;
  }

  // Claim the row back only after the transport accepted the job.
  const updated = await pool.query(
    `UPDATE ingestion_jobs
     SET status = 'queued', last_error = $3, updated_at = NOW()
     WHERE id = $1 AND organization_id = $2 AND status IN ('queued', 'running')`,
    [job.id, job.organization_id, "Recovered after an interrupted attempt"]
  );

  logger.warn("ingestion.job_requeued", {
    jobId: job.id,
    organizationId: job.organization_id,
    sourceType: job.source_type,
    sourceId: job.source_id,
    previousStatus: job.status,
  });

  return (updated.rowCount ?? 0) > 0;
}

/**
 * Find jobs nobody is working on and give them back to the queue.
 *
 * Run once at worker start (that is when a crashed job is first observed) and
 * periodically afterwards. Bounded per sweep so a large backlog cannot turn one
 * tick into thousands of Redis round trips.
 */
export async function recoverStaleJobs(
  options: { staleAfterMs?: number; now?: Date; limit?: number } = {}
): Promise<RecoverySummary> {
  const staleAfterMs = options.staleAfterMs ?? resolveStaleJobMs();
  const summary: RecoverySummary = {
    scanned: 0,
    requeued: 0,
    failed: 0,
    skipped: 0,
  };

  if (staleAfterMs <= 0) {
    return summary;
  }

  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;

  const stuck = await pool.query<StuckJobRow>(
    `SELECT id, organization_id, source_type, source_id, status,
            attempts, max_attempts, file_path, updated_at
     FROM ingestion_jobs
     WHERE status IN ('queued', 'running')
       AND updated_at < $1
     ORDER BY updated_at ASC
     LIMIT $2`,
    [new Date(now.getTime() - staleAfterMs), limit]
  );

  summary.scanned = stuck.rows.length;

  for (const job of stuck.rows) {
    const action = classifyStaleJob(
      {
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        updatedAt: job.updated_at,
      },
      now.getTime(),
      staleAfterMs
    );

    if (action === "ignore") {
      summary.skipped += 1;
      continue;
    }

    if (action === "fail") {
      await failInterruptedJob(job);
      summary.failed += 1;
      continue;
    }

    if (await requeueInterruptedJob(job)) {
      summary.requeued += 1;
    } else {
      summary.skipped += 1;
    }
  }

  if (summary.requeued > 0 || summary.failed > 0) {
    logger.warn("ingestion.recovery_swept", { ...summary, staleAfterMs });
  }

  return summary;
}
