import "../config/env.js";

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

/**
 * Liveness probe for Redis, separate from the queue connections.
 *
 * It must not create or reuse the ingestion queue: a readiness check runs every
 * few seconds on a host, and reusing a BullMQ connection would make the probe
 * wait behind queue traffic. The offline queue is disabled and the retry
 * strategy returns null so a Redis outage produces a fast rejection instead of
 * a growing queue of pending commands.
 *
 * The attempt is bounded here rather than only by the caller: a refused or
 * black-holed connection can stay pending past any deadline, and a probe that
 * leaves one socket behind per call would leak for as long as Redis stays down.
 */
export async function pingRedis(timeoutMs = 1_500): Promise<void> {
  const client = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: timeoutMs,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });

  // connect()/ping() carry the real failure; an unhandled 'error' event would
  // crash the process instead of failing the probe.
  client.on("error", () => undefined);

  const attempt = (async () => {
    await client.connect();
    await client.ping();
  })();

  // If the deadline wins, `attempt` must not surface later as an unhandled
  // rejection, and the socket still has to be closed by the finally below.
  attempt.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Redis did not answer within ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref();
  });

  try {
    await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
    client.disconnect();
  }
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
