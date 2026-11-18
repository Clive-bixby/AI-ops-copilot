import { Queue } from "bullmq";
import Redis from "ioredis";

const connection = new (Redis as any)(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

export const ingestionQueue = new Queue("ingestion", { connection });
export const embeddingQueue = new Queue("embedding", { connection });
export const workerConnection = connection;
