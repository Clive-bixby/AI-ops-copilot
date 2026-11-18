import { Worker } from "bullmq";
import { workerConnection } from "../core/queue.js";

const worker = new Worker(
  "ingestion",
  async (job) => {
    console.log("Processing ingestion job", job.id, job.data);
    return { ok: true };
  },
  { connection: workerConnection }
);

worker.on("completed", (job) => console.log("Job completed", job.id));
worker.on("failed", (job, err) => console.error("Job failed", job?.id, err));

console.log("Worker started");
