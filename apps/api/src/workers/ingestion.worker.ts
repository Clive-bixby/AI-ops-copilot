import { Worker } from "bullmq";

import { pool } from "../core/db.js";
import { logger } from "../core/logger.js";
import { createRedisConnection, INGESTION_QUEUE_NAME } from "../core/queue.js";
import { runIngestionJob } from "../modules/ingestion/jobRunner.js";
import type { IngestionJobPayload } from "../modules/ingestion/jobRunner.js";

const concurrency = Number(process.env.INGESTION_CONCURRENCY || 2);

// A Worker blocks on Redis while waiting for jobs, so it gets its own
// connection rather than sharing the producer's.
const workerConnection = createRedisConnection();

const worker = new Worker<IngestionJobPayload>(
  INGESTION_QUEUE_NAME,
  async (job) => {
    await runIngestionJob(job.data);
    return { jobId: job.data.jobId };
  },
  { connection: workerConnection, concurrency }
);

worker.on("completed", (job) => {
  logger.info("worker.job_completed", {
    queue: INGESTION_QUEUE_NAME,
    jobId: job?.id,
  });
});

worker.on("failed", (job, error) => {
  logger.error("worker.job_failed", {
    queue: INGESTION_QUEUE_NAME,
    jobId: job?.id,
    attemptsMade: job?.attemptsMade,
    error,
  });
});

worker.on("error", (error) => {
  logger.error("worker.error", { queue: INGESTION_QUEUE_NAME, error });
});

logger.info("worker.started", { queue: INGESTION_QUEUE_NAME, concurrency });

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info("worker.stopping", { signal });

  // close() waits for the in-flight job, so a deploy does not cut a job mid-way.
  await worker.close();
  await workerConnection.quit();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
