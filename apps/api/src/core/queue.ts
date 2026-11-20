import { Queue } from "bullmq";
import { Redis } from "ioredis";

import { logger } from "./logger.js";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export const INGESTION_QUEUE_NAME = "ingestion";

/**
 * BullMQ needs `maxRetriesPerRequest: null` on blocking connections, and a
 * Worker must not share the connection a Queue is using: a blocking command
 * would otherwise stall the producer. Callers that run a Worker create their own
 * connection with this factory.
 */
export function createRedisConnection(): Redis {
  return new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

let queueConnection: Redis | null = null;
let ingestionQueueInstance: Queue | null = null;

/**
 * Created on first use, not at import time: importing the ingestion modules in
 * a test or a one-off script must not open a Redis socket that keeps the
 * process alive.
 */
export function getIngestionQueue(): Queue {
  if (ingestionQueueInstance) {
    return ingestionQueueInstance;
  }

  queueConnection = createRedisConnection();
  queueConnection.on("error", (error) => {
    logger.error("queue.redis_error", { error });
  });

  ingestionQueueInstance = new Queue(INGESTION_QUEUE_NAME, {
    connection: queueConnection,
    defaultJobOptions: {
      // The database ledger is the source of truth; these attempts only control
      // how often the transport retries a failed handler.
      attempts: 3,
      backoff: { type: "exponential", delay: 3_000 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
    },
  });

  return ingestionQueueInstance;
}

export async function closeQueues(): Promise<void> {
  if (ingestionQueueInstance) {
    await ingestionQueueInstance.close();
    ingestionQueueInstance = null;
  }

  if (queueConnection) {
    await queueConnection.quit();
    queueConnection = null;
  }
}
