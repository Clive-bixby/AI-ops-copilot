import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  addMembership,
  apiRequest,
  createOrganization,
  createUser,
  getPool,
  resetDatabase,
  setupTestDatabase,
  startServer,
  tokenFor,
} from "./harness.js";
import type { TestServer } from "./harness.js";

/**
 * Ingestion recovery and reprocess semantics.
 *
 * The suite runs against Postgres only. The requeue path needs Redis and is
 * covered by the worker's own behaviour; what is tested here is the part that
 * can silently lose or misreport work: a row abandoned by a crashed worker, and
 * a reprocess request for a document whose original upload no longer exists.
 */

let server: TestServer;
let organizationId: string;
let userId: string;

const STALE_AFTER_MS = 10 * 60_000;

async function insertDocument(input: {
  content?: string | null;
  processingStatus?: string;
}): Promise<string> {
  const processingStatus = input.processingStatus ?? "failed";

  const result = await getPool().query<{ id: string }>(
    `INSERT INTO documents (organization_id, filename, content, processing_status, processed_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'processed' THEN NOW() ELSE NULL END)
     RETURNING id`,
    [organizationId, "runbook.md", input.content ?? null, processingStatus]
  );

  return result.rows[0]!.id;
}

async function insertJob(input: {
  sourceId: string;
  status: "queued" | "running" | "failed" | "succeeded";
  attempts?: number;
  maxAttempts?: number;
  ageMinutes?: number;
}): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO ingestion_jobs (
       organization_id, source_type, source_id, status, attempts, max_attempts,
       last_error, started_at, created_at, updated_at
     )
     VALUES (
       $1, 'document', $2, $3, $4, $5, $6,
       CASE WHEN $3 = 'running' THEN NOW() - ($7::int * INTERVAL '1 minute') ELSE NULL END,
       NOW() - ($7::int * INTERVAL '1 minute'),
       NOW() - ($7::int * INTERVAL '1 minute')
     )
     RETURNING id`,
    [
      organizationId,
      input.sourceId,
      input.status,
      input.attempts ?? 1,
      input.maxAttempts ?? 3,
      input.status === "failed" ? "Parser rejected the file" : null,
      input.ageMinutes ?? 0,
    ]
  );

  return result.rows[0]!.id;
}

before(async () => {
  await setupTestDatabase();
  server = await startServer();
});

after(async () => {
  await server.close();

  // The health route may have opened the shared queue connection when a Redis
  // happened to be reachable; close it so the test process exits.
  try {
    const { closeQueues } = await import("../../core/queue.js");
    await closeQueues();
  } catch {
    // Nothing was opened, or it was already closed.
  }
});

beforeEach(async () => {
  // resetDatabase truncates users, so the account is created per test.
  await resetDatabase();
  organizationId = await createOrganization("Acme");
  userId = await createUser();
  await addMembership(userId, organizationId, "member");
});

describe("reprocess after the original upload is gone", () => {
  it("refuses with 409 when no text was stored and no job is running", async () => {
    const documentId = await insertDocument({ content: null, processingStatus: "failed" });

    // The last attempt deletes the upload, so this is the state of a document
    // that failed before extraction: the file is gone and the row has no text.
    await insertJob({ sourceId: documentId, status: "failed", attempts: 3 });

    const response = await apiRequest<{ error: string; code: string; documentId: string }>(
      server.url,
      "POST",
      `/documents/${documentId}/reprocess`,
      { token: tokenFor(userId), organizationId }
    );

    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, "source_file_unavailable");
    assert.equal(response.body.documentId, documentId);
    assert.match(response.body.error, /Upload the file again/);

    // Nothing was queued: the refusal must not leave a job that cannot succeed.
    const jobs = await getPool().query(
      "SELECT COUNT(*)::int AS total FROM ingestion_jobs WHERE source_id = $1 AND status IN ('queued', 'running')",
      [documentId]
    );
    assert.equal(jobs.rows[0].total, 0);
  });

  it("does not refuse while extraction may still be in progress", async () => {
    const documentId = await insertDocument({ content: null, processingStatus: "pending" });
    await insertJob({ sourceId: documentId, status: "queued", attempts: 0 });

    const response = await apiRequest(
      server.url,
      "POST",
      `/documents/${documentId}/reprocess`,
      { token: tokenFor(userId), organizationId }
    );

    // 202 when a queue is reachable, 503 when it is not (this suite starts no
    // Redis). Either way the guard must not answer 409.
    assert.notEqual(response.status, 409, JSON.stringify(response.body));
    assert.ok([202, 503].includes(response.status), `unexpected ${response.status}`);
  });

  it("accepts a reprocess for a document that has stored text", async () => {
    const documentId = await insertDocument({
      content: "Restart the checkout worker before rolling back.",
      processingStatus: "processed",
    });

    const response = await apiRequest(
      server.url,
      "POST",
      `/documents/${documentId}/reprocess`,
      { token: tokenFor(userId), organizationId }
    );

    assert.notEqual(response.status, 409, JSON.stringify(response.body));
    assert.ok([202, 503].includes(response.status), `unexpected ${response.status}`);
  });
});

describe("recovering jobs left running by a crashed worker", () => {
  it("fails a stuck job that has no attempts left and clears the document state", async () => {
    const documentId = await insertDocument({ content: null, processingStatus: "processing" });
    const jobId = await insertJob({
      sourceId: documentId,
      status: "running",
      attempts: 3,
      maxAttempts: 3,
      ageMinutes: 60,
    });

    const { recoverStaleJobs } = await import("../../modules/ingestion/jobRecovery.js");
    const summary = await recoverStaleJobs({ staleAfterMs: STALE_AFTER_MS });

    assert.equal(summary.failed, 1, JSON.stringify(summary));

    const job = await getPool().query<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM ingestion_jobs WHERE id = $1",
      [jobId]
    );
    assert.equal(job.rows[0]!.status, "failed");
    assert.match(job.rows[0]!.last_error ?? "", /Interrupted after 3 of 3 attempts/);

    // Without this the document keeps showing "processing" with no job that
    // could ever finish it.
    const document = await getPool().query<{
      processing_status: string;
      processing_error: string | null;
    }>("SELECT processing_status, processing_error FROM documents WHERE id = $1", [
      documentId,
    ]);
    assert.equal(document.rows[0]!.processing_status, "failed");
    assert.match(document.rows[0]!.processing_error ?? "", /Interrupted after/);
  });

  it("leaves a job that is still inside the stale window alone", async () => {
    const documentId = await insertDocument({ content: "text", processingStatus: "processing" });
    const jobId = await insertJob({
      sourceId: documentId,
      status: "running",
      attempts: 1,
      ageMinutes: 0,
    });

    const { recoverStaleJobs } = await import("../../modules/ingestion/jobRecovery.js");
    const summary = await recoverStaleJobs({ staleAfterMs: STALE_AFTER_MS });

    assert.equal(summary.scanned, 0, JSON.stringify(summary));

    const job = await getPool().query<{ status: string }>(
      "SELECT status FROM ingestion_jobs WHERE id = $1",
      [jobId]
    );
    assert.equal(job.rows[0]!.status, "running");
  });

  it("does nothing when the sweep is disabled", async () => {
    const documentId = await insertDocument({ content: "text" });
    const jobId = await insertJob({
      sourceId: documentId,
      status: "running",
      attempts: 3,
      ageMinutes: 60,
    });

    const { recoverStaleJobs } = await import("../../modules/ingestion/jobRecovery.js");
    const summary = await recoverStaleJobs({ staleAfterMs: 0 });

    assert.equal(summary.scanned, 0);

    const job = await getPool().query<{ status: string }>(
      "SELECT status FROM ingestion_jobs WHERE id = $1",
      [jobId]
    );
    assert.equal(job.rows[0]!.status, "running");
  });
});

describe("ingestion health", () => {
  it("reports backlog and stuck jobs for the calling tenant", async () => {
    const documentId = await insertDocument({ content: "text" });
    await insertJob({ sourceId: documentId, status: "running", attempts: 3, ageMinutes: 60 });
    await insertJob({
      sourceId: await insertDocument({ content: "text" }),
      status: "queued",
      attempts: 0,
      ageMinutes: 5,
    });

    const response = await apiRequest<{
      staleAfterSeconds: number;
      jobs: {
        counts: Record<string, number>;
        total: number;
        stuckRunning: number;
        oldestQueuedSeconds: number | null;
      };
      queue: { available: boolean };
      worker: { status: string };
    }>(server.url, "GET", "/ingestion/health", {
      token: tokenFor(userId),
      organizationId,
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.staleAfterSeconds, STALE_AFTER_MS / 1000);
    assert.equal(response.body.jobs.counts.running, 1);
    assert.equal(response.body.jobs.counts.queued, 1);
    assert.equal(response.body.jobs.total, 2);
    assert.equal(response.body.jobs.stuckRunning, 1);
    assert.ok((response.body.jobs.oldestQueuedSeconds ?? 0) >= 240);
    assert.equal(response.body.queue.available, false);
    assert.equal(response.body.worker.status, "unknown");
  });

  it("scopes counts to the caller's organization", async () => {
    const otherOrg = await createOrganization("Globex");
    const otherDoc = await getPool().query<{ id: string }>(
      `INSERT INTO documents (organization_id, filename, content)
       VALUES ($1, 'other.md', 'text') RETURNING id`,
      [otherOrg]
    );
    await getPool().query(
      `INSERT INTO ingestion_jobs (organization_id, source_type, source_id, status)
       VALUES ($1, 'document', $2, 'queued')`,
      [otherOrg, otherDoc.rows[0]!.id]
    );

    const response = await apiRequest<{ jobs: { total: number } }>(
      server.url,
      "GET",
      "/ingestion/health",
      { token: tokenFor(userId), organizationId }
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.jobs.total, 0);
  });

  it("requires an authenticated organization", async () => {
    const response = await apiRequest(server.url, "GET", "/ingestion/health");
    assert.equal(response.status, 401);
  });
});
