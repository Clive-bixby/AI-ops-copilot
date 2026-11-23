import { Worker } from "bullmq";

import { envInt } from "../config/env.js";
import { pool } from "../core/db.js";
import { logger } from "../core/logger.js";
import {
  createRedisConnection,
  INGESTION_QUEUE_NAME,
  startWorkerHeartbeat,
} from "../core/queue.js";
import { getIngestionQueueSnapshot } from "../modules/ingestion/jobQueue.js";
import { recoverStaleJobs } from "../modules/ingestion/jobRecovery.js";
import { runIngestionJob } from "../modules/ingestion/jobRunner.js";
import type { IngestionJobPayload } from "../modules/ingestion/jobRunner.js";

const concurrency = Number(process.env.INGESTION_CONCURRENCY || 2);

// A job row left behind by a previous process is invisible to BullMQ: the
// transport job was either never accepted or was already removed. Sweeping at
// startup is what turns those rows back into work right after a redeploy.
const RECOVERY_INTERVAL_MS = envInt("INGESTION_RECOVERY_INTERVAL_MS", 60_000);
const stopHeartbeat = startWorkerHeartbeat();

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

logger.info("worker.started", {
  queue: INGESTION_QUEUE_NAME,
  concurrency,
  recoveryIntervalMs: RECOVERY_INTERVAL_MS,
});

async function sweep(): Promise<void> {
  try {
    await recoverStaleJobs();
  } catch (error) {
    // A failed sweep must not kill the worker: the jobs it was about to recover
    // are still there, and the next tick tries again.
    logger.error("worker.recovery_failed", { error });
  }
}

void sweep();
const recoveryTimer = setInterval(() => void sweep(), RECOVERY_INTERVAL_MS);
recoveryTimer.unref();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info("worker.stopping", { signal });

  clearInterval(recoveryTimer);

  // close() waits for the in-flight job, so a deploy does not cut a job mid-way.
  await worker.close();
  await stopHeartbeat();

  // What is left in the queue is the honest drain signal: an empty queue means
  // this stop lost nothing, a non-empty one tells the operator where it went.
  try {
    logger.info("worker.drained", {
      queue: INGESTION_QUEUE_NAME,
      remaining: await getIngestionQueueSnapshot(),
    });
  } catch (error) {
    logger.warn("worker.drain_unavailable", { error });
  }

  await workerConnection.quit();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
