import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  createOrganization,
  getPool,
  hasPool,
  resetDatabase,
  setupTestDatabase,
} from "./harness.js";

/**
 * Loaded in `before()`, never at import time: both import `core/db`, which
 * builds the pool from the environment as it is *then*. A static import here
 * evaluated `core/db` before the harness applied `TEST_DATABASE_URL`, so this
 * suite ran against whatever `.env` named -- a deployed database in this
 * checkout. Types are erased, so the annotations cost nothing.
 */
let runIngestionJob: typeof import("../../modules/ingestion/jobRunner.js")["runIngestionJob"];
let resetEmbeddingProvider: typeof import("../../modules/ai/embedding/index.js")["resetEmbeddingProvider"];

/**
 * Ingestion failure modes, driven through the real job runner against real
 * PostgreSQL.
 *
 * The embedding provider is a local server, so the suite proves parse, chunk,
 * embed, index and the cleanup rules without a network call: the pipeline is
 * exercised for real, only the model is a stub (the same division the compose
 * e2e makes). Each test asserts what the ledger and the document row say after
 * a failure, and whether the uploaded original survived -- the two things a user
 * sees when an upload does not appear.
 */

type ScriptedBatch = { status: number };

let provider: { url: string; calls: number; resetQueue: (q: ScriptedBatch[]) => void; close: () => void };
let queue: ScriptedBatch[] = [];
let directory: string;
let organizationId: string;

function unitVector(): number[] {
  return Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));
}

async function startEmbeddingStub(): Promise<typeof provider> {
  const state = { calls: 0 };

  const server = http.createServer((request, response) => {
    let raw = "";

    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });

    request.on("end", () => {
      state.calls += 1;

      const scripted = queue.shift() ?? { status: 200 };

      if (scripted.status !== 200) {
        response.writeHead(scripted.status, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "embedding provider unavailable" } }));
        return;
      }

      let input: unknown = [];
      try {
        input = (JSON.parse(raw) as { input?: unknown }).input ?? [];
      } catch {
        input = [];
      }

      const texts = Array.isArray(input) ? input : [input];

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          model: "test-embed",
          data: texts.map(() => ({ embedding: unitVector() })),
        })
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    get url() {
      return `http://127.0.0.1:${address.port}`;
    },
    get calls() {
      return state.calls;
    },
    resetQueue: (next) => {
      queue = next;
      state.calls = 0;
    },
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

async function createDocument(maxAttempts: number): Promise<{
  documentId: string;
  jobId: string;
}> {
  const document = await getPool().query<{ id: string }>(
    `INSERT INTO documents (organization_id, filename, processing_status)
     VALUES ($1, 'upload.txt', 'pending')
     RETURNING id`,
    [organizationId]
  );

  const documentId = document.rows[0]!.id;

  const job = await getPool().query<{ id: string }>(
    `INSERT INTO ingestion_jobs (
       organization_id, source_type, source_id, status, attempts, max_attempts
     )
     VALUES ($1, 'document', $2, 'queued', 0, $3)
     RETURNING id`,
    [organizationId, documentId, maxAttempts]
  );

  return { documentId, jobId: job.rows[0]!.id };
}

async function writeUpload(name: string, contents: string): Promise<string> {
  const target = path.join(directory, `${Date.now()}-${name}`);
  await fs.writeFile(target, contents);

  return target;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);

    return true;
  } catch {
    return false;
  }
}

async function readJob(jobId: string): Promise<{
  status: string;
  attempts: number;
  last_error: string | null;
}> {
  const result = await getPool().query<{
    status: string;
    attempts: number;
    last_error: string | null;
  }>("SELECT status, attempts, last_error FROM ingestion_jobs WHERE id = $1", [jobId]);

  return result.rows[0]!;
}

async function readDocument(documentId: string): Promise<{
  processing_status: string;
  processing_error: string | null;
}> {
  const result = await getPool().query<{
    processing_status: string;
    processing_error: string | null;
  }>("SELECT processing_status, processing_error FROM documents WHERE id = $1", [
    documentId,
  ]);

  return result.rows[0]!;
}

async function chunkCount(documentId: string): Promise<number> {
  const result = await getPool().query<{ total: number }>(
    `SELECT COUNT(*)::int AS total
     FROM source_chunks
     WHERE organization_id = $1 AND source_type = 'document' AND source_id = $2`,
    [organizationId, documentId]
  );

  return result.rows[0]?.total ?? 0;
}

before(async () => {
  await setupTestDatabase();

  ({ runIngestionJob } = await import("../../modules/ingestion/jobRunner.js"));
  ({ resetEmbeddingProvider } = await import("../../modules/ai/embedding/index.js"));

  directory = await fs.mkdtemp(path.join(os.tmpdir(), "opspilot-ingest-"));
  provider = await startEmbeddingStub();

  process.env.EMBEDDING_PROVIDER = "openai-compatible";
  process.env.EMBEDDING_BASE_URL = provider.url;
  process.env.EMBEDDING_MODEL = "test-embed";
  process.env.EMBEDDING_DIMENSIONS = "768";
  process.env.EMBEDDING_API_KEY = "test-key";
  resetEmbeddingProvider();
});

after(async () => {
  provider?.close();

  // `before()` may have failed before the directory existed; a TypeError from
  // this hook used to bury the real setup error.
  if (directory) {
    await fs.rm(directory, { recursive: true, force: true });
  }

  for (const name of [
    "EMBEDDING_PROVIDER",
    "EMBEDDING_BASE_URL",
    "EMBEDDING_MODEL",
    "EMBEDDING_DIMENSIONS",
    "EMBEDDING_API_KEY",
  ]) {
    delete process.env[name];
  }

  resetEmbeddingProvider?.();

  if (hasPool()) {
    await getPool().end();
  }
});

describe("ingestion job failure modes", () => {
  beforeEach(async () => {
    await resetDatabase();
    organizationId = await createOrganization("Ingestion Failure Org");
    queue = [];
  });

  it("records a malformed PDF as a parse failure and deletes the upload on the final attempt", async () => {
    const { documentId, jobId } = await createDocument(1);
    const filePath = await writeUpload("broken.pdf", "%PDF-1.4\nnot actually a PDF\n%%EOF");

    await assert.rejects(
      runIngestionJob({
        jobId,
        organizationId,
        sourceType: "document",
        sourceId: documentId,
        filePath,
      })
    );

    const job = await readJob(jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.attempts, 1);
    assert.match(job.last_error ?? "", /Failed to parse document|extractable text/);

    const document = await readDocument(documentId);
    assert.equal(document.processing_status, "failed");
    assert.equal(document.processing_error, job.last_error);

    assert.equal(await chunkCount(documentId), 0, "nothing may be indexed from a failed parse");
    assert.equal(await exists(filePath), false, "the last attempt must delete the original");
  });

  it("keeps the upload while a retry is still possible, then indexes it on the retry", async () => {
    const { documentId, jobId } = await createDocument(2);
    const filePath = await writeUpload(
      "runbook.txt",
      "Checkout requests fail with a connection pool error. The pool is exhausted by long-lived transactions.\n"
    );

    // Two embedding attempts per batch, both fail.
    provider.resetQueue([{ status: 500 }, { status: 500 }]);

    await assert.rejects(
      runIngestionJob({
        jobId,
        organizationId,
        sourceType: "document",
        sourceId: documentId,
        filePath,
      })
    );

    const afterFailure = await readJob(jobId);
    assert.equal(afterFailure.status, "failed");
    assert.equal(afterFailure.attempts, 1);
    assert.match(afterFailure.last_error ?? "", /embedding/i);
    assert.equal(await exists(filePath), true, "a retry needs the original file");
    assert.equal(await chunkCount(documentId), 0, "a failed embedding must not leave a half index");
    assert.equal((await readDocument(documentId)).processing_status, "failed");

    // The transport redelivers the job; the provider is healthy now.
    provider.resetQueue([]);

    await runIngestionJob({
      jobId,
      organizationId,
      sourceType: "document",
      sourceId: documentId,
      filePath,
    });

    const afterRetry = await readJob(jobId);
    assert.equal(afterRetry.status, "succeeded");
    assert.equal(afterRetry.attempts, 2);
    assert.equal(afterRetry.last_error, null);

    assert.ok((await chunkCount(documentId)) > 0);
    assert.equal((await readDocument(documentId)).processing_status, "processed");
    assert.equal(await exists(filePath), false, "a successful index deletes the original");

    // A redelivery after success is a no-op: the ledger is the source of truth.
    const chunksAfterSuccess = await chunkCount(documentId);
    await runIngestionJob({
      jobId,
      organizationId,
      sourceType: "document",
      sourceId: documentId,
      filePath,
    });
    assert.equal(await chunkCount(documentId), chunksAfterSuccess);
  });

  it("does not delete the upload when the failure is terminal but no file was passed", async () => {
    const { documentId, jobId } = await createDocument(1);

    await getPool().query(
      "UPDATE documents SET content = $2 WHERE id = $1",
      [documentId, "Connection pool exhausted during checkout."]
    );

    provider.resetQueue([]);

    await runIngestionJob({
      jobId,
      organizationId,
      sourceType: "document",
      sourceId: documentId,
    });

    const job = await readJob(jobId);
    assert.equal(job.status, "succeeded");
    assert.ok((await chunkCount(documentId)) > 0);
  });
});
