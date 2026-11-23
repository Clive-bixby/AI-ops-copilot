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
 *
 * `offlineQueue: false` is for producers only. A command issued while Redis is
 * down was buffered and waited for the connection to come back, so
 * `queue.add()` never settled: an upload that could not be queued hung the
 * request instead of returning 503, and the buffered command could add the job
 * minutes later, long after the caller had been told it failed. A worker keeps
 * the default, because its blocking commands must survive a reconnect.
 */
export function createRedisConnection(
  options: { offlineQueue?: boolean } = {}
): Redis {
  return new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    ...(options.offlineQueue === false ? { enableOfflineQueue: false } : {}),
  });
}

/**
 * Run one command on a throwaway Redis connection with a hard deadline.
 *
 * Shared by the health probes so they cannot drift apart. Each connection is
 * lazy, has no offline queue and no retry strategy: a Redis outage must produce
 * a fast rejection, not a pending command that outlives the probe.
 */
async function withRedisClient<T>(
  timeoutMs: number,
  run: (client: Redis) => Promise<T>
): Promise<T> {
  const client = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: timeoutMs,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });

  // connect()/the command carry the real failure; an unhandled 'error' event
  // would crash the process instead of failing the probe.
  client.on("error", () => undefined);

  const attempt = (async () => {
    await client.connect();
    return run(client);
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
    return await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
    client.disconnect();
  }
}

/**
 * Liveness probe for Redis, separate from the queue connections.
 *
 * It must not create or reuse the ingestion queue: a readiness check runs every
 * few seconds on a host, and reusing a BullMQ connection would make the probe
 * wait behind queue traffic. The attempt is bounded here rather than only by
 * the caller, because a refused or black-holed connection can stay pending past
 * any deadline, and a probe that leaves one socket behind per call would leak
 * for as long as Redis stays down.
 */
export async function pingRedis(timeoutMs = 1_500): Promise<void> {
  await withRedisClient(timeoutMs, async (client) => {
    await client.ping();
  });
}

/**
 * Reject a promise that has not settled in time.
 *
 * BullMQ resolves its client before it sends anything, so while Redis is
 * unreachable `queue.add()` and `getJobCounts()` wait for a connection that may
 * never come. A request that needs an answer -- an upload, a health probe --
 * cannot wait for that, and the caller reports the outage instead.
 */
export function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Queue did not answer within ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
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

  queueConnection = createRedisConnection({ offlineQueue: false });
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
  const queue = ingestionQueueInstance;
  const connection = queueConnection;

  ingestionQueueInstance = null;
  queueConnection = null;

  // Drop the producer socket before closing the queue. Closing a BullMQ queue
  // whose connection is still reconnecting left a rejected internal connection
  // promise with no owner, and Node exits on an unhandled rejection: a bad
  // REDIS_URL could crash the API during shutdown instead of logging it.
  // disconnect() is synchronous and stops the retry loop immediately.
  connection?.disconnect();

  if (queue) {
    await queue.close().catch(() => undefined);
  }

  if (connection) {
    // quit() is graceful and can wait for a connection that is not there;
    // shutdown must not hang because Redis is the thing that is broken.
    await Promise.race([
      connection.quit().catch(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref();
      }),
    ]);

    connection.disconnect();
  }
}

/**
 * The worker's liveness marker.
 *
 * A queue with waiting jobs proves nothing: the API enqueues whether or not a
 * worker exists, and a dead worker looks exactly like a busy one from the
 * outside. The beat is a TTL key, so a crashed worker stops looking alive on its
 * own instead of leaving a stale flag behind that has to be cleaned up.
 */
export const WORKER_HEARTBEAT_KEY = "ingestion:worker:heartbeat";

/** Survives a missed beat; short enough that a dead worker is noticed quickly. */
export const WORKER_HEARTBEAT_TTL_SECONDS = 45;

/** Last beat in epoch milliseconds, or null when no worker has reported. */
export async function readWorkerHeartbeat(
  timeoutMs = 1_500
): Promise<number | null> {
  const value = await withRedisClient(timeoutMs, (client) =>
    client.get(WORKER_HEARTBEAT_KEY)
  );

  if (!value) {
    return null;
  }

  const seenAt = Number(value);
  return Number.isFinite(seenAt) ? seenAt : null;
}

/**
 * Start reporting that this process can run ingestion jobs.
 *
 * One long-lived connection rather than one per beat: on a metered Redis (the
 * free tier this deploys to) connection churn costs more than the command.
 * Returns an idempotent stop function that removes the key, so a clean shutdown
 * is reported immediately instead of waiting for the TTL.
 */
export function startWorkerHeartbeat(
  options: { intervalMs?: number } = {}
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? 15_000;
  const connection = createRedisConnection();

  connection.on("error", (error) => {
    logger.error("worker.heartbeat_redis_error", { error });
  });

  const beat = async (): Promise<void> => {
    try {
      await connection.set(
        WORKER_HEARTBEAT_KEY,
        String(Date.now()),
        "EX",
        WORKER_HEARTBEAT_TTL_SECONDS
      );
    } catch (error) {
      logger.warn("worker.heartbeat_failed", { error });
    }
  };

  void beat();
  const timer = setInterval(() => void beat(), intervalMs);
  timer.unref();

  let stopped = false;

  return async () => {
    if (stopped) {
      return;
    }
    stopped = true;

    clearInterval(timer);

    try {
      await connection.del(WORKER_HEARTBEAT_KEY);
    } catch {
      // The TTL expires it shortly; a shutdown must not fail on this.
    }

    connection.disconnect();
  };
}
