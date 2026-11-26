import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  addMembership,
  apiRequest,
  createOrganization,
  createUser,
  getPool,
  hasPool,
  resetDatabase,
  setupTestDatabase,
  startServer,
  tokenFor,
} from "./harness.js";
import type { TestServer } from "./harness.js";

/**
 * The ingestion status endpoints over HTTP.
 *
 * The recovery policy and the job ledger already have suites; what was missing
 * was the read surface: `/ingestion/health` must summarise only the caller's
 * tenant, the job list must validate its filters, and the reindex sweep must
 * stay bounded at 200 sources per request. Assertions are on the returned
 * numbers and rows, not on a status alone.
 *
 * Redis is deliberately not required: `/ingestion/health` reports an
 * unreachable queue as `queue.available: false` instead of failing, which is
 * itself part of the contract. The queue fields are therefore not asserted.
 */

type JobsBody = {
  total: number;
  // The ledger row is returned with its SQL column names.
  jobs: Array<{ id: string; status: string; source_type: string }>;
};

type HealthBody = {
  generatedAt: string;
  staleAfterSeconds: number;
  jobs: {
    counts: Record<string, number>;
    total: number;
    stuckRunning: number;
    oldestQueuedSeconds: number | null;
  };
  queue: { available: boolean };
};

type ReindexBody = {
  requested: number;
  enqueued: number;
  deduplicated: number;
  failed: number;
  sourceTypes: string[];
  cappedAt: number;
};

let server: TestServer;
let orgA: string;
let orgB: string;
let ownerA: string;
let ownerB: string;

function auth(userId: string, organizationId: string) {
  return { token: tokenFor(userId), organizationId };
}

async function insertJob(
  organizationId: string,
  status: "queued" | "running" | "succeeded" | "failed" | "skipped"
): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO ingestion_jobs (organization_id, source_type, source_id, status)
     VALUES ($1, 'document', gen_random_uuid(), $2)
     RETURNING id`,
    [organizationId, status]
  );

  return result.rows[0]!.id;
}

async function insertDocuments(organizationId: string, count: number): Promise<void> {
  await getPool().query(
    `INSERT INTO documents (organization_id, filename, processing_status)
     SELECT $1, 'document-' || series || '.md', 'pending'
     FROM generate_series(1, $2::int) AS series`,
    [organizationId, count]
  );
}

before(async () => {
  await setupTestDatabase();

  // Redis is deliberately not required by this suite, and a reindex cap test
  // records 200 job rows: pointed at a listening Redis each dispatch is fast, but
  // pointed at an unreachable hostname every dispatch waits out the probe
  // deadline and the test takes minutes. The local .env names the compose
  // service, which does not resolve from the test process, so pin a closed
  // loopback port here: a refused connection fails in milliseconds and the
  // endpoint's "queue unavailable" path is what gets exercised.
  process.env.REDIS_URL = "redis://127.0.0.1:6399";

  server = await startServer();
});

after(async () => {
  delete process.env.REDIS_URL;

  await server?.close();
  if (hasPool()) {
    await getPool().end();
  }
});

beforeEach(async () => {
  await resetDatabase();

  orgA = await createOrganization("Ingestion Org A");
  orgB = await createOrganization("Ingestion Org B");

  ownerA = await createUser("owner@ingest-a.example.test");
  ownerB = await createUser("owner@ingest-b.example.test");

  await addMembership(ownerA, orgA, "owner");
  await addMembership(ownerB, orgB, "owner");
});

describe("GET /ingestion/health", () => {
  it("summarises only the caller's job ledger", async () => {
    await insertJob(orgA, "succeeded");
    await insertJob(orgA, "failed");
    await insertJob(orgA, "succeeded");

    await insertJob(orgB, "succeeded");
    await insertJob(orgB, "queued");
    await insertJob(orgB, "running");
    await insertJob(orgB, "failed");
    await insertJob(orgB, "skipped");

    const asA = await apiRequest<HealthBody>(
      server.url,
      "GET",
      "/ingestion/health",
      auth(ownerA, orgA)
    );
    const asB = await apiRequest<HealthBody>(
      server.url,
      "GET",
      "/ingestion/health",
      auth(ownerB, orgB)
    );

    assert.equal(asA.status, 200, JSON.stringify(asA.body));
    assert.equal(asA.body.jobs.total, 3);
    assert.equal(asA.body.jobs.counts.succeeded, 2);
    assert.equal(asA.body.jobs.counts.failed, 1);
    assert.equal(asA.body.jobs.counts.queued, 0);
    assert.equal(typeof asA.body.staleAfterSeconds, "number");
    assert.ok(asA.body.generatedAt);

    assert.equal(asB.status, 200);
    assert.equal(asB.body.jobs.total, 5);
    assert.equal(asB.body.jobs.counts.skipped, 1);

    // A breakdown that leaked tenants would make every tenant look blocked by
    // somebody else's failed jobs.
    assert.notEqual(asA.body.jobs.total, asB.body.jobs.total);
  });

  it("requires an organization header", async () => {
    const response = await apiRequest(
      server.url,
      "GET",
      "/ingestion/health",
      { token: tokenFor(ownerA) }
    );

    assert.equal(response.status, 400);
  });
});

describe("GET /ingestion/jobs", () => {
  it("filters by status and source type within the caller's organization", async () => {
    const succeeded = await insertJob(orgA, "succeeded");
    await insertJob(orgA, "failed");
    await insertJob(orgB, "succeeded");

    const filtered = await apiRequest<JobsBody>(
      server.url,
      "GET",
      "/ingestion/jobs?status=succeeded&sourceType=document",
      auth(ownerA, orgA)
    );

    assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
    assert.equal(filtered.body.total, 1);
    assert.deepEqual(
      filtered.body.jobs.map((job) => job.id),
      [succeeded]
    );
    assert.equal(filtered.body.jobs[0]!.status, "succeeded");
    assert.equal(filtered.body.jobs[0]!.source_type, "document");
  });

  it("rejects an unsupported status, source type or page size", async () => {
    for (const query of [
      "?status=exploded",
      "?sourceType=spreadsheet",
      "?limit=0",
      "?limit=101",
      "?limit=abc",
    ]) {
      const response = await apiRequest(
        server.url,
        "GET",
        `/ingestion/jobs${query}`,
        auth(ownerA, orgA)
      );

      assert.equal(response.status, 400, `${query} answered ${response.status}`);
    }
  });
});

describe("POST /ingestion/reindex", () => {
  it("caps one call at 200 sources and reports the cap", async () => {
    await insertDocuments(orgA, 205);
    await insertDocuments(orgB, 5);

    const response = await apiRequest<ReindexBody>(
      server.url,
      "POST",
      "/ingestion/reindex",
      { ...auth(ownerA, orgA), body: {} }
    );

    assert.equal(response.status, 202, JSON.stringify(response.body));
    assert.equal(response.body.cappedAt, 200);
    assert.equal(response.body.requested, 200, "the sweep must stop at the cap");
    assert.deepEqual(
      response.body.sourceTypes.slice().sort(),
      ["document", "log", "ticket"]
    );
  });

  it("honours an explicit source-type filter and rejects an unknown one", async () => {
    await insertDocuments(orgA, 3);
    await getPool().query(
      `INSERT INTO tickets (organization_id, title, description, status, priority)
       VALUES ($1, 'Checkout latency', 'Seeded by the reindex suite.', 'open', 'high')`,
      [orgA]
    );
    await getPool().query(
      `INSERT INTO tickets (organization_id, title, description, status, priority)
       VALUES ($1, 'Billing webhook failures', 'Seeded by the reindex suite.', 'open', 'high')`,
      [orgA]
    );

    const ticketsOnly = await apiRequest<ReindexBody>(
      server.url,
      "POST",
      "/ingestion/reindex",
      { ...auth(ownerA, orgA), body: { sourceTypes: ["ticket"] } }
    );

    assert.equal(ticketsOnly.status, 202, JSON.stringify(ticketsOnly.body));
    assert.equal(ticketsOnly.body.requested, 2);
    assert.deepEqual(ticketsOnly.body.sourceTypes, ["ticket"]);

    const invalid = await apiRequest(
      server.url,
      "POST",
      "/ingestion/reindex",
      { ...auth(ownerA, orgA), body: { sourceTypes: ["spreadsheet"] } }
    );
    const empty = await apiRequest(
      server.url,
      "POST",
      "/ingestion/reindex",
      { ...auth(ownerA, orgA), body: { sourceTypes: [] } }
    );

    assert.equal(invalid.status, 400);
    assert.equal(empty.status, 400);
  });
});
