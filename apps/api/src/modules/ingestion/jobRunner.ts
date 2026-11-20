import { pool } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { indexDocument } from "./documentIngest.service.js";
import { indexLogGroups } from "./logGroup.service.js";
import type { SourceType } from "./sourceIndex.service.js";
import { indexTicket } from "./ticketIngest.service.js";

export type IngestionJobPayload = {
  jobId: string;
  organizationId: string;
  sourceType: SourceType;
  sourceId: string;
  /** Temporary upload path, shared through the uploads volume. */
  filePath?: string;
};

/**
 * Run one ingestion job.
 *
 * The claim is an UPDATE rather than a read: a redelivered BullMQ job must not
 * run twice concurrently, and a job that already succeeded must be a no-op. The
 * ledger records the real outcome even when the process dies mid-run, because
 * the status was moved to `running` before any embedding work started.
 */
export async function runIngestionJob(
  payload: IngestionJobPayload
): Promise<void> {
  const { jobId, organizationId, sourceType, sourceId } = payload;

  const claimed = await pool.query<{ attempts: number; max_attempts: number }>(
    `
    UPDATE ingestion_jobs
    SET status = 'running',
        attempts = attempts + 1,
        started_at = COALESCE(started_at, NOW()),
        updated_at = NOW()
    WHERE id = $1
      AND organization_id = $2
      AND status IN ('queued', 'failed', 'running')
    RETURNING attempts, max_attempts
    `,
    [jobId, organizationId]
  );

  if (!claimed.rows[0]) {
    logger.info("ingestion.job_already_finished", { jobId, organizationId });
    return;
  }

  try {
    if (sourceType === "document") {
      await indexDocument({
        organizationId,
        documentId: sourceId,
        ...(payload.filePath ? { filePath: payload.filePath } : {}),
        deleteFileAfter: true,
      });
    } else if (sourceType === "ticket") {
      await indexTicket({ organizationId, ticketId: sourceId });
    } else {
      await indexLogGroups({ organizationId, groupIds: [sourceId] });
    }

    await pool.query(
      `
      UPDATE ingestion_jobs
      SET status = 'succeeded',
          last_error = NULL,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE id = $1 AND organization_id = $2
      `,
      [jobId, organizationId]
    );

    logger.info("ingestion.job_succeeded", {
      jobId,
      organizationId,
      sourceType,
      sourceId,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Ingestion job failed";

    await pool.query(
      `
      UPDATE ingestion_jobs
      SET status = 'failed',
          last_error = $3,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE id = $1 AND organization_id = $2
      `,
      [jobId, organizationId, message]
    );

    logger.error("ingestion.job_failed", {
      jobId,
      organizationId,
      sourceType,
      sourceId,
      error,
    });

    // Rethrow so BullMQ applies the configured retry policy.
    throw error;
  }
}
