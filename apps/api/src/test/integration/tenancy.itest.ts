import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { createHash } from "node:crypto";
import { readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 * Cross-tenant access, asserted per domain.
 *
 * The tenant predicate lives in application SQL (`WHERE organization_id = $1`)
 * and there is no Row Level Security, so a single forgotten predicate is a
 * silent leak. Each block below creates real rows in organization B, acts as a
 * fully authorized member of organization A, and asserts that B's data is
 * neither returned nor mutated.
 *
 * Organization ids are never accepted from the client: `x-organization-id` is
 * verified against `memberships` by `orgMiddleware`. These tests therefore try
 * the two realistic attacks — pointing the header at another tenant (403), and
 * using a first-class row id from another tenant with a legitimate header
 * (404 / filtered).
 */

type InvestigationDetail = {
  investigation: { id: string; status: string };
  evidence: Array<{ id: string }>;
};

type DocumentListRow = { id: string; filename: string };
type DocumentDetail = { id: string; chunks: Array<{ id: string }> };
type TicketRow = { id: string; title: string };
type LogRow = { id: string; message: string };
type JobList = { total: number; jobs: Array<{ id: string }> };
type MemberList = { members: Array<{ userId: string; email: string }>; total: number };
type ReindexBody = { requested: number; enqueued: number; failed: number };

let server: TestServer;
let orgA: string;
let orgB: string;
let ownerA: string;
let ownerB: string;

function auth(userId: string, organizationId: string) {
  return { token: tokenFor(userId), organizationId };
}

async function insertDocument(
  organizationId: string,
  filename: string,
  content: string
): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    // `documents_processed_at_check` ties 'processed' to a non-null timestamp.
    `INSERT INTO documents (
       organization_id, filename, content, processing_status, processed_at
     )
     VALUES ($1, $2, $3, 'processed', NOW())
     RETURNING id`,
    [organizationId, filename, content]
  );

  return result.rows[0]!.id;
}

async function insertTicket(
  organizationId: string,
  title: string
): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO tickets (organization_id, title, description, status, priority)
     VALUES ($1, $2, 'Seeded by the tenancy suite.', 'open', 'high')
     RETURNING id`,
    [organizationId, title]
  );

  return result.rows[0]!.id;
}

async function insertLog(
  organizationId: string,
  message: string
): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO logs (organization_id, level, message, metadata, timestamp)
     VALUES ($1, 'error', $2, '{}'::jsonb, NOW())
     RETURNING id`,
    [organizationId, message]
  );

  return result.rows[0]!.id;
}

async function insertLogGroup(organizationId: string): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO log_groups (
       organization_id, level, template, template_hash,
       window_start, window_end, event_count, first_seen, last_seen
     )
     VALUES (
       $1, 'error', 'checkout failed for tenant {id}', 'tenancy-hash',
       NOW() - INTERVAL '5 minutes', NOW(), 3, NOW() - INTERVAL '5 minutes', NOW()
     )
     RETURNING id`,
    [organizationId]
  );

  return result.rows[0]!.id;
}

async function insertJob(
  organizationId: string,
  sourceId: string
): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO ingestion_jobs (organization_id, source_type, source_id, status)
     VALUES ($1, 'document', $2, 'succeeded')
     RETURNING id`,
    [organizationId, sourceId]
  );

  return result.rows[0]!.id;
}

function unitVector(index: number, dimensions: number): string {
  const values = new Array<string>(dimensions).fill("0");
  values[index] = "1";
  return `[${values.join(",")}]`;
}

async function insertChunk(input: {
  organizationId: string;
  sourceId: string;
  content: string;
  vectorIndex: number;
  model: string;
  dimensions: number;
}): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO source_chunks (
       organization_id, source_type, source_id, chunk_index, content, embedding,
       embedding_model, embedding_dimensions, chunk_hash, source_created_at, metadata
     )
     VALUES ($1, 'document', $2, 0, $3, $4::vector, $5, $6, $7, NOW(), '{}'::jsonb)
     RETURNING id`,
    [
      input.organizationId,
      input.sourceId,
      input.content,
      unitVector(input.vectorIndex, input.dimensions),
      input.model,
      input.dimensions,
      createHash("md5").update(input.content).digest("hex"),
    ]
  );

  return result.rows[0]!.id;
}

async function createInvestigation(
  userId: string,
  organizationId: string,
  title = "Checkout API returns intermittent 500 responses"
): Promise<string> {
  const response = await apiRequest<InvestigationDetail>(
    server.url,
    "POST",
    "/investigations",
    {
      ...auth(userId, organizationId),
      body: {
        title,
        description:
          "Since 09:40 the checkout endpoint returns HTTP 500 for roughly one in twenty requests.",
        severity: "high",
        service: "checkout-api",
      },
    }
  );

  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.investigation.id;
}

before(async () => {
  await setupTestDatabase();
  server = await startServer();
});

after(async () => {
  await server?.close();
  if (hasPool()) {
    await getPool().end();
  }
});

beforeEach(async () => {
  await resetDatabase();

  orgA = await createOrganization("Org A");
  orgB = await createOrganization("Org B");

  ownerA = await createUser("owner@a.example.test");
  ownerB = await createUser("owner@b.example.test");

  await addMembership(ownerA, orgA, "owner");
  await addMembership(ownerB, orgB, "owner");
});

describe("documents", () => {
  it("never lists, reads or deletes another organization's document", async () => {
    const documentA = await insertDocument(orgA, "a-runbook.md", "Runbook A");
    const documentB = await insertDocument(orgB, "b-secrets.md", "Org B internal notes");

    const list = await apiRequest<DocumentListRow[]>(
      server.url,
      "GET",
      "/documents",
      auth(ownerA, orgA)
    );
    const foreign = await apiRequest(
      server.url,
      "GET",
      `/documents/${documentB}`,
      auth(ownerA, orgA)
    );
    const reprocess = await apiRequest(
      server.url,
      "POST",
      `/documents/${documentB}/reprocess`,
      auth(ownerA, orgA)
    );
    const remove = await apiRequest(
      server.url,
      "DELETE",
      `/documents/${documentB}`,
      auth(ownerA, orgA)
    );
    const own = await apiRequest<DocumentDetail>(
      server.url,
      "GET",
      `/documents/${documentA}`,
      auth(ownerA, orgA)
    );
    // A first-class row id is not the only attack: the header itself is
    // re-checked against membership before any query runs.
    const retargeted = await apiRequest(
      server.url,
      "GET",
      `/documents/${documentA}`,
      auth(ownerA, orgB)
    );

    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.map((row) => row.id),
      [documentA]
    );
    assert.equal(foreign.status, 404);
    assert.equal(reprocess.status, 404);
    assert.equal(remove.status, 404);
    assert.equal(own.status, 200);
    assert.equal(retargeted.status, 403);
    assert.equal(own.body.id, documentA);

    const stillThere = await getPool().query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM documents WHERE id = $1",
      [documentB]
    );
    assert.equal(stillThere.rows[0]!.count, "1", "the foreign document must survive");
  });
});

describe("tickets and logs", () => {
  it("never returns another organization's tickets", async () => {
    const ticketA = await insertTicket(orgA, "A: checkout latency");
    const ticketB = await insertTicket(orgB, "B: billing webhook failures");

    const list = await apiRequest<TicketRow[]>(
      server.url,
      "GET",
      "/tickets",
      auth(ownerA, orgA)
    );
    const foreign = await apiRequest(
      server.url,
      "GET",
      `/tickets/${ticketB}`,
      auth(ownerA, orgA)
    );
    const own = await apiRequest<TicketRow>(
      server.url,
      "GET",
      `/tickets/${ticketA}`,
      auth(ownerA, orgA)
    );

    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.map((row) => row.id),
      [ticketA]
    );
    assert.equal(foreign.status, 404);
    assert.equal(own.status, 200);
    assert.equal(own.body.id, ticketA);
  });

  it("never returns another organization's logs or log groups", async () => {
    const logA = await insertLog(orgA, "A: connection pool exhausted");
    const logB = await insertLog(orgB, "B: secret rotation failed");
    const groupB = await insertLogGroup(orgB);

    const list = await apiRequest<LogRow[]>(
      server.url,
      "GET",
      "/logs",
      auth(ownerA, orgA)
    );
    const foreignGroup = await apiRequest(
      server.url,
      "GET",
      `/logs/groups/${groupB}`,
      auth(ownerA, orgA)
    );

    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.map((row) => row.id),
      [logA]
    );
    assert.ok(
      !list.body.some((row) => row.id === logB),
      "the foreign log must not appear in the list"
    );
    assert.equal(foreignGroup.status, 404);
  });
});

describe("ingestion", () => {
  it("scopes the job ledger and the reindex sweep to the caller's organization", async () => {
    const documentA = await insertDocument(orgA, "a-runbook.md", "Runbook A");
    const documentB = await insertDocument(orgB, "b-runbook.md", "Runbook B");
    await insertTicket(orgB, "B: only exists to inflate a broken reindex");
    await insertLog(orgB, "B: only exists to inflate a broken reindex");
    await insertLogGroup(orgB);

    const jobA = await insertJob(orgA, documentA);
    const jobB = await insertJob(orgB, documentB);

    const jobs = await apiRequest<JobList>(
      server.url,
      "GET",
      "/ingestion/jobs",
      auth(ownerA, orgA)
    );
    const foreignJob = await apiRequest(
      server.url,
      "GET",
      `/ingestion/jobs/${jobB}`,
      auth(ownerA, orgA)
    );
    const ownJob = await apiRequest(
      server.url,
      "GET",
      `/ingestion/jobs/${jobA}`,
      auth(ownerA, orgA)
    );

    assert.equal(jobs.status, 200);
    assert.equal(jobs.body.total, 1);
    assert.deepEqual(
      jobs.body.jobs.map((job) => job.id),
      [jobA]
    );
    assert.equal(foreignJob.status, 404);
    assert.equal(ownJob.status, 200);

    // Organization A owns exactly one source of any type; organization B owns
    // four. A reindex that leaked would ask for five.
    const reindex = await apiRequest<ReindexBody>(
      server.url,
      "POST",
      "/ingestion/reindex",
      { ...auth(ownerA, orgA), body: {} }
    );

    assert.equal(reindex.status, 202);
    assert.equal(reindex.body.requested, 1);
  });
});

describe("investigations and their sub-resources", () => {
  it("hides every sub-resource of another organization's investigation", async () => {
    const investigationB = await createInvestigation(ownerB, orgB);
    const evidenceId = "00000000-0000-4000-8000-000000000000";

    const detail = await apiRequest(
      server.url,
      "GET",
      `/investigations/${investigationB}`,
      auth(ownerA, orgA)
    );
    const patch = await apiRequest(
      server.url,
      "PATCH",
      `/investigations/${investigationB}`,
      { ...auth(ownerA, orgA), body: { title: "Cross-tenant edit" } }
    );
    const timeline = await apiRequest(
      server.url,
      "GET",
      `/investigations/${investigationB}/timeline`,
      auth(ownerA, orgA)
    );
    const analysis = await apiRequest(
      server.url,
      "GET",
      `/investigations/${investigationB}/analysis`,
      auth(ownerA, orgA)
    );
    const analyze = await apiRequest(
      server.url,
      "POST",
      `/investigations/${investigationB}/analyze`,
      auth(ownerA, orgA)
    );
    const note = await apiRequest(
      server.url,
      "POST",
      `/investigations/${investigationB}/notes`,
      { ...auth(ownerA, orgA), body: { body: "Cross-tenant note" } }
    );
    const comment = await apiRequest(
      server.url,
      "POST",
      `/investigations/${investigationB}/comments`,
      { ...auth(ownerA, orgA), body: { body: "Cross-tenant comment" } }
    );
    const questions = await apiRequest(
      server.url,
      "GET",
      `/investigations/${investigationB}/questions`,
      auth(ownerA, orgA)
    );
    const ask = await apiRequest(
      server.url,
      "POST",
      `/investigations/${investigationB}/questions`,
      { ...auth(ownerA, orgA), body: { question: "What caused it?" } }
    );
    const collect = await apiRequest(
      server.url,
      "POST",
      `/investigations/${investigationB}/evidence/collect`,
      auth(ownerA, orgA)
    );
    const unlink = await apiRequest(
      server.url,
      "DELETE",
      `/investigations/${investigationB}/evidence/${evidenceId}`,
      auth(ownerA, orgA)
    );
    const hypothesis = await apiRequest(
      server.url,
      "PATCH",
      `/investigations/${investigationB}/hypotheses/${evidenceId}`,
      { ...auth(ownerA, orgA), body: { status: "supported" } }
    );

    for (const [label, response] of [
      ["detail", detail],
      ["patch", patch],
      ["timeline", timeline],
      ["analysis", analysis],
      ["analyze", analyze],
      ["note", note],
      ["comment", comment],
      ["questions", questions],
      ["ask", ask],
      ["collect", collect],
      ["unlink", unlink],
      ["hypothesis", hypothesis],
    ] as Array<[string, { status: number }]>) {
      assert.equal(response.status, 404, `${label} answered ${response.status}`);
    }
  });

  it("refuses to cite a source that belongs to another organization", async () => {
    const investigationA = await createInvestigation(ownerA, orgA);
    const documentB = await insertDocument(orgB, "b-secret.md", "Org B internal notes");

    const link = await apiRequest(
      server.url,
      "POST",
      `/investigations/${investigationA}/evidence`,
      {
        ...auth(ownerA, orgA),
        body: { sourceType: "document", sourceId: documentB },
      }
    );

    assert.equal(link.status, 404);
    assert.match(
      (link.body as { error: string }).error,
      /source not found/i
    );

    const stored = await getPool().query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM investigation_evidence WHERE investigation_id = $1",
      [investigationA]
    );
    assert.equal(stored.rows[0]!.count, "0", "a refused citation must not be stored");
  });
});

describe("organization and member resources", () => {
  it("shows only the caller's organization members", async () => {
    const response = await apiRequest<MemberList>(
      server.url,
      "GET",
      "/organization/members",
      auth(ownerA, orgA)
    );

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.members.map((member) => member.userId).sort(),
      [ownerA].sort()
    );
    assert.equal(response.body.total, 1);
  });
});

describe("AI endpoints and the retrieval data layer", () => {
  it("refuses a foreign organization header on search and ask", async () => {
    const search = await apiRequest(server.url, "POST", "/ai/search", {
      ...auth(ownerA, orgB),
      body: { query: "how do I roll back", limit: 5 },
    });
    const ask = await apiRequest(server.url, "POST", "/ai/ask", {
      ...auth(ownerA, orgB),
      body: { question: "how do I roll back a deployment" },
    });

    assert.equal(search.status, 403);
    assert.equal(ask.status, 403);
  });

  it("returns only the caller's chunks from both retrieval arms", async () => {
    // Loaded after the harness has pointed DATABASE_URL at the test database.
    const { searchSimilar, searchFullText } = await import(
      "../../modules/ai/vector.service.js"
    );
    const { getEmbeddingConfig } = await import(
      "../../modules/ingestion/embeddingConfig.js"
    );

    const config = getEmbeddingConfig();
    const documentA = await insertDocument(orgA, "a-runbook.md", "alpha runbook");
    const documentB = await insertDocument(orgB, "b-runbook.md", "orgbuniquemarker runbook");

    const chunkA = await insertChunk({
      organizationId: orgA,
      sourceId: documentA,
      content: "Roll back a bad deployment by redeploying the previous image.",
      vectorIndex: 0,
      model: config.model,
      dimensions: config.dimensions,
    });
    const chunkB = await insertChunk({
      organizationId: orgB,
      sourceId: documentB,
      content: "orgbuniquemarker rollback procedure for the billing service.",
      vectorIndex: 0,
      model: config.model,
      dimensions: config.dimensions,
    });

    const queryEmbedding = new Array<number>(config.dimensions).fill(0);
    queryEmbedding[0] = 1;

    const vectorHits = await searchSimilar(queryEmbedding, orgA, 10, 0.65);
    const vectorHitIds = vectorHits.map((hit) => hit.id);

    assert.ok(vectorHitIds.includes(chunkA), "the caller's own chunk is retrievable");
    assert.deepEqual(
      [...new Set(vectorHits.map((hit) => hit.sourceId))],
      [documentA],
      "the vector arm must only return the caller's sources"
    );
    assert.ok(!vectorHitIds.includes(chunkB));

    const keywordHitsA = await searchFullText("orgbuniquemarker", orgA, 10);
    const keywordHitsB = await searchFullText("orgbuniquemarker", orgB, 10);

    assert.deepEqual(keywordHitsA, [], "the keyword arm is tenant-scoped too");
    assert.deepEqual(
      keywordHitsB.map((hit) => hit.id),
      [chunkB]
    );
  });
});

/**
 * The upload route is the only way a file enters OPA, and it had no HTTP test:
 * the sniffing tests cover the predicate, not the route that applies it, the
 * cleanup after a rejection, or which tenant ends up owning the row.
 */
const UPLOAD_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../uploads"
);

function uploadFilesPresent(): Set<string> {
  try {
    return new Set(readdirSync(UPLOAD_DIR));
  } catch {
    return new Set();
  }
}

function removeFilesCreatedSince(before: Set<string>): void {
  for (const name of uploadFilesPresent()) {
    if (before.has(name)) continue;

    try {
      unlinkSync(path.join(UPLOAD_DIR, name));
    } catch {
      // A worker container may have removed it first; that is the outcome we want.
    }
  }
}

async function uploadFile(input: {
  userId: string;
  organizationId: string;
  filename: string;
  content: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([input.content], { type: "application/octet-stream" }),
    input.filename
  );

  const response = await fetch(`${server.url}/documents/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenFor(input.userId)}`,
      "x-organization-id": input.organizationId,
    },
    body: form,
  });

  const text = await response.text();
  const body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};

  return { status: response.status, body };
}

describe("document upload", () => {
  it("rejects a renamed binary and leaves no file behind", async () => {
    const before = uploadFilesPresent();

    const response = await uploadFile({
      userId: ownerA,
      organizationId: orgA,
      filename: "runbook.pdf",
      content: "This is a markdown runbook wearing a PDF extension.",
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.match(String(response.body.error), /does not start with a PDF header/);

    assert.deepEqual(
      [...uploadFilesPresent()].filter((name) => !before.has(name)),
      [],
      "the rejected upload must be deleted, not left in the uploads directory"
    );

    const stored = await getPool().query<{ total: number }>(
      "SELECT COUNT(*)::int AS total FROM documents WHERE organization_id = $1",
      [orgA]
    );
    assert.equal(stored.rows[0]!.total, 0, "a rejected file must not create a document");
  });

  it("stores an accepted file under the caller's organization only", async () => {
    const before = uploadFilesPresent();

    try {
      const response = await uploadFile({
        userId: ownerA,
        organizationId: orgA,
        filename: "a-rollback.md",
        content: "Roll back a bad deploy by redeploying the previous image.\n",
      });

      // 202 when Redis is reachable, 503 when it is not: the document row is
      // written before the queue is contacted in both cases.
      assert.ok(
        [202, 503].includes(response.status),
        `unexpected ${response.status}: ${JSON.stringify(response.body)}`
      );

      const documentId = String(
        response.status === 202 ? response.body.id : response.body.documentId
      );
      assert.match(documentId, /^[0-9a-f-]{36}$/);

      const stored = await getPool().query<{ organization_id: string; filename: string }>(
        "SELECT organization_id, filename FROM documents WHERE id = $1",
        [documentId]
      );
      assert.equal(stored.rows[0]!.organization_id, orgA);
      assert.equal(stored.rows[0]!.filename, "a-rollback.md");

      const otherTenant = await apiRequest<DocumentListRow[]>(
        server.url,
        "GET",
        "/documents",
        auth(ownerB, orgB)
      );
      assert.deepEqual(otherTenant.body, []);
    } finally {
      removeFilesCreatedSince(before);
    }
  });
});

describe("admin member directory", () => {
  it("refuses a member and shows an owner only their organization's members", async () => {
    const memberA = await createUser("member@a.example.test");
    await addMembership(memberA, orgA, "member");

    const memberB = await createUser("member@b.example.test");
    await addMembership(memberB, orgB, "member");

    const denied = await apiRequest(server.url, "GET", "/admin/members", auth(memberA, orgA));
    const directory = await apiRequest<MemberList>(
      server.url,
      "GET",
      "/admin/members",
      auth(ownerA, orgA)
    );
    // The same directory is readable by every member on /organization/members:
    // the role gate belongs to the admin route, not to the data.
    const openDirectory = await apiRequest<MemberList>(
      server.url,
      "GET",
      "/organization/members",
      auth(memberA, orgA)
    );

    assert.equal(denied.status, 403);
    assert.equal(directory.status, 200);
    assert.deepEqual(
      directory.body.members.map((member) => member.email).sort(),
      ["member@a.example.test", "owner@a.example.test"]
    );
    assert.equal(directory.body.total, 2);
    assert.ok(
      !directory.body.members.some((member) => member.email === "member@b.example.test"),
      "another organization's member must not appear"
    );

    assert.equal(openDirectory.status, 200);
    assert.equal(openDirectory.body.total, 2);
  });
});
