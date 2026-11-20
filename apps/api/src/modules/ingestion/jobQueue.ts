import { pool } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { getIngestionQueue } from "../../core/queue.js";
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
      organization_id, source_type, source_id, status, embedding_config_hash
    )
    VALUES ($1, $2, $3, 'queued', $4)
    ON CONFLICT (organization_id, source_type, source_id)
      WHERE status IN ('queued', 'running')
    DO NOTHING
    RETURNING *
    `,
    [options.organizationId, options.sourceType, options.sourceId, config.hash]
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
    await getIngestionQueue().add(
      "ingest",
      {
        jobId: job.id,
        organizationId: options.organizationId,
        sourceType: options.sourceType,
        sourceId: options.sourceId,
        filePath: options.filePath,
      },
      { jobId: job.id }
    );
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

  const result = await pool.query<IngestionJobRow>(
    `SELECT * FROM ingestion_jobs
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
    `SELECT * FROM ingestion_jobs WHERE id = $1 AND organization_id = $2`,
    [jobId, organizationId]
  );

  return result.rows[0] ?? null;
}
