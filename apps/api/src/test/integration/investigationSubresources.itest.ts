import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
 * Investigation sub-resources over HTTP: the timeline, manual evidence
 * link/unlink, a human hypothesis verdict, and the discussion entries as they
 * appear in the timeline.
 *
 * The analysis provider is not involved: the hypothesis is seeded directly, so
 * the verdict endpoint is exercised without a model call. Evidence linking is
 * also model-free. Assertions are on stored rows and on the composed timeline,
 * because that is what the SPA reads back.
 */

type Activity = {
  id: string;
  type: string;
  actorEmail: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
};

type Evidence = {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceTitle: string;
  excerpt: string;
  matchType: string;
  origin: string;
  relevance: string;
};

type Detail = {
  investigation: { id: string; status: string };
  activity: Activity[];
  evidence: Evidence[];
};

type LinkBody = Detail & { added: boolean };

type TimelineBody = {
  investigationId: string;
  events: Array<{
    kind: string;
    at: string;
    activityId: string | null;
    evidenceId: string | null;
    sourceType: string | null;
    actorEmail: string | null;
    title: string;
    detail: string | null;
  }>;
  summary: {
    total: number;
    clipped: boolean;
    undated: number;
    evidence: number;
    activity: number;
    bySourceType: Record<string, number>;
  };
};

type Hypothesis = {
  id: string;
  status: string;
  statusSource: string;
  statement: string;
};

let server: TestServer;
let orgA: string;
let orgB: string;
let ownerA: string;
let ownerB: string;

function auth(userId: string, organizationId: string) {
  return { token: tokenFor(userId), organizationId };
}

async function createInvestigation(
  userId: string,
  organizationId: string,
  title = "Checkout API returns intermittent 500 responses"
): Promise<string> {
  const response = await apiRequest<Detail>(server.url, "POST", "/investigations", {
    ...auth(userId, organizationId),
    body: {
      title,
      description:
        "Since 09:40 the checkout endpoint returns HTTP 500 for roughly one in twenty requests.",
      severity: "high",
      service: "checkout-api",
    },
  });

  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.investigation.id;
}

async function insertDocument(
  organizationId: string,
  filename: string,
  content: string
): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO documents (
       organization_id, filename, content, processing_status, processed_at
     )
     VALUES ($1, $2, $3, 'processed', NOW())
     RETURNING id`,
    [organizationId, filename, content]
  );

  return result.rows[0]!.id;
}

async function getDetail(
  userId: string,
  organizationId: string,
  investigationId: string
): Promise<Detail> {
  const response = await apiRequest<Detail>(
    server.url,
    "GET",
    `/investigations/${investigationId}`,
    auth(userId, organizationId)
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

async function insertHypothesis(
  investigationId: string,
  organizationId: string,
  userId: string
): Promise<string> {
  const analysis = await getPool().query<{ id: string }>(
    `INSERT INTO investigation_analyses (
       investigation_id, organization_id, status, analysis_version, provider, model, created_by
     )
     VALUES ($1, $2, 'succeeded', 1, 'test', 'test-model', $3)
     RETURNING id`,
    [investigationId, organizationId, userId]
  );

  const hypothesis = await getPool().query<{ id: string }>(
    `INSERT INTO investigation_hypotheses (
       investigation_id, organization_id, statement, rationale, statement_hash,
       analysis_id, created_by
     )
     VALUES ($1, $2, 'The connection pool is exhausted', 'Observed waits', $3, $4, $5)
     RETURNING id`,
    [
      investigationId,
      organizationId,
      `hash-${randomUUID()}`,
      analysis.rows[0]!.id,
      userId,
    ]
  );

  return hypothesis.rows[0]!.id;
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

  orgA = await createOrganization("Sub-resource Org A");
  orgB = await createOrganization("Sub-resource Org B");

  ownerA = await createUser("owner@sub-a.example.test");
  ownerB = await createUser("owner@sub-b.example.test");

  await addMembership(ownerA, orgA, "owner");
  await addMembership(ownerB, orgB, "owner");
});

describe("evidence linking", () => {
  it("links a source once, is idempotent on retry, and unlinks it with activity", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const documentId = await insertDocument(
      orgA,
      "runbook.md",
      "The connection pool is exhausted by long-lived transactions."
    );

    const linked = await apiRequest<LinkBody>(
      server.url,
      "POST",
      `/investigations/${investigationId}/evidence`,
      {
        ...auth(ownerA, orgA),
        body: {
          sourceType: "document",
          sourceId: documentId,
          reason: "It names the same pool exhaustion",
        },
      }
    );

    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    assert.equal(linked.body.added, true);
    assert.equal(linked.body.evidence.length, 1);

    const evidence = linked.body.evidence[0]!;
    assert.equal(evidence.sourceId, documentId);
    assert.equal(evidence.sourceTitle, "runbook.md");
    assert.equal(evidence.matchType, "manual");
    assert.equal(evidence.origin, "manual");
    assert.ok(evidence.excerpt.includes("connection pool is exhausted"));
    assert.ok(
      linked.body.activity.some(
        (entry) =>
          entry.type === "evidence_added" &&
          entry.actorEmail === "owner@sub-a.example.test"
      ),
      "linking is recorded as attributed activity"
    );

    // The same link twice is a no-op, not a duplicate row.
    const again = await apiRequest<LinkBody>(
      server.url,
      "POST",
      `/investigations/${investigationId}/evidence`,
      {
        ...auth(ownerA, orgA),
        body: { sourceType: "document", sourceId: documentId },
      }
    );

    assert.equal(again.status, 200);
    assert.equal(again.body.added, false);
    assert.equal(again.body.evidence.length, 1);

    const unlinked = await apiRequest(
      server.url,
      "DELETE",
      `/investigations/${investigationId}/evidence/${evidence.id}`,
      auth(ownerA, orgA)
    );

    assert.equal(unlinked.status, 204);

    const afterUnlink = await getDetail(ownerA, orgA, investigationId);
    assert.deepEqual(afterUnlink.evidence, []);
    assert.ok(
      afterUnlink.activity.some((entry) => entry.type === "evidence_removed"),
      "unlinking is recorded as activity"
    );

    const againUnlink = await apiRequest(
      server.url,
      "DELETE",
      `/investigations/${investigationId}/evidence/${evidence.id}`,
      auth(ownerA, orgA)
    );

    assert.equal(againUnlink.status, 404);

    const stored = await getPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM investigation_evidence
       WHERE investigation_id = $1`,
      [investigationId]
    );
    assert.equal(stored.rows[0]!.count, "0");
  });

  it("rejects a malformed source id and an unknown source", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);

    const malformed = await apiRequest(
      server.url,
      "POST",
      `/investigations/${investigationId}/evidence`,
      {
        ...auth(ownerA, orgA),
        body: { sourceType: "document", sourceId: "not-a-uuid" },
      }
    );
    const unknown = await apiRequest(
      server.url,
      "POST",
      `/investigations/${investigationId}/evidence`,
      {
        ...auth(ownerA, orgA),
        body: {
          sourceType: "document",
          sourceId: "00000000-0000-4000-8000-000000000000",
        },
      }
    );

    assert.equal(malformed.status, 400);
    assert.equal(unknown.status, 404);
    assert.match((unknown.body as { error: string }).error, /source not found/i);
  });
});

describe("timeline", () => {
  it("merges activity and evidence, keeping discussion attribution and distinct kinds", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const documentId = await insertDocument(
      orgA,
      "gateway.log",
      "connection pool exhausted while checkout was under load"
    );

    const note = await apiRequest<{ activity: Activity }>(
      server.url,
      "POST",
      `/investigations/${investigationId}/notes`,
      {
        ...auth(ownerA, orgA),
        body: { body: "Checked pg_stat_activity; the pool is saturated." },
      }
    );
    const comment = await apiRequest<{ activity: Activity }>(
      server.url,
      "POST",
      `/investigations/${investigationId}/comments`,
      {
        ...auth(ownerA, orgA),
        body: { body: "Can we confirm the limit before rolling back?" },
      }
    );
    const link = await apiRequest(
      server.url,
      "POST",
      `/investigations/${investigationId}/evidence`,
      {
        ...auth(ownerA, orgA),
        body: { sourceType: "document", sourceId: documentId },
      }
    );

    assert.equal(note.status, 201);
    assert.equal(comment.status, 201);
    assert.equal(link.status, 201);

    const timeline = await apiRequest<TimelineBody>(
      server.url,
      "GET",
      `/investigations/${investigationId}/timeline`,
      auth(ownerA, orgA)
    );

    assert.equal(timeline.status, 200, JSON.stringify(timeline.body));
    assert.equal(timeline.body.investigationId, investigationId);
    assert.equal(timeline.body.summary.evidence, 1);
    assert.equal(timeline.body.summary.bySourceType.document, 1);
    assert.equal(timeline.body.summary.total, timeline.body.events.length);
    assert.equal(
      timeline.body.summary.activity,
      timeline.body.events.filter((event) => event.kind !== "evidence_source").length
    );

    const kinds = timeline.body.events.map((event) => event.kind);
    for (const kind of ["created", "note", "comment", "evidence_added", "evidence_source"]) {
      assert.ok(kinds.includes(kind), `timeline is missing a ${kind} event`);
    }

    for (const event of timeline.body.events) {
      assert.ok(!Number.isNaN(new Date(event.at).getTime()), `bad timestamp: ${event.at}`);
      assert.ok(event.title.length > 0);
    }

    // Discussion entries keep their author in the composed view, so the
    // timeline can be read as "who did what" rather than an anonymous log.
    const noteEvent = timeline.body.events.find((event) => event.kind === "note");
    const commentEvent = timeline.body.events.find((event) => event.kind === "comment");

    assert.equal(noteEvent?.activityId, note.body.activity.id);
    assert.equal(noteEvent?.actorEmail, "owner@sub-a.example.test");
    assert.equal(commentEvent?.activityId, comment.body.activity.id);
    assert.equal(commentEvent?.actorEmail, "owner@sub-a.example.test");

    const evidenceEvent = timeline.body.events.find(
      (event) => event.kind === "evidence_source"
    );
    assert.ok(evidenceEvent?.evidenceId);
    assert.equal(evidenceEvent?.sourceType, "document");
  });

  it("answers 404 for a malformed investigation id", async () => {
    const response = await apiRequest(
      server.url,
      "GET",
      "/investigations/not-an-id/timeline",
      auth(ownerA, orgA)
    );

    assert.equal(response.status, 404);
  });
});

describe("hypothesis verdict", () => {
  it("records a human verdict with its source and activity, without a model call", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const hypothesisId = await insertHypothesis(investigationId, orgA, ownerA);

    const response = await apiRequest<{ hypothesis: Hypothesis }>(
      server.url,
      "PATCH",
      `/investigations/${investigationId}/hypotheses/${hypothesisId}`,
      { ...auth(ownerA, orgA), body: { status: "supported" } }
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.hypothesis.id, hypothesisId);
    assert.equal(response.body.hypothesis.status, "supported");
    assert.equal(response.body.hypothesis.statusSource, "user");

    const analysis = await apiRequest<{ hypotheses: Hypothesis[] }>(
      server.url,
      "GET",
      `/investigations/${investigationId}/analysis`,
      auth(ownerA, orgA)
    );

    assert.equal(analysis.status, 200);
    assert.deepEqual(
      analysis.body.hypotheses.map((item) => [item.id, item.status]),
      [[hypothesisId, "supported"]]
    );

    const detail = await getDetail(ownerA, orgA, investigationId);
    const verdict = detail.activity.find((entry) => entry.type === "hypothesis_status");

    assert.ok(verdict, "the verdict must be in the activity stream");
    assert.deepEqual(verdict?.metadata, {
      hypothesisId,
      from: "unverified",
      to: "supported",
    });
    assert.equal(verdict?.actorEmail, "owner@sub-a.example.test");

    const stored = await getPool().query<{ status: string; status_source: string }>(
      `SELECT status, status_source FROM investigation_hypotheses WHERE id = $1`,
      [hypothesisId]
    );
    assert.deepEqual(stored.rows[0], {
      status: "supported",
      status_source: "user",
    });
  });

  it("rejects an unsupported verdict value and an unknown hypothesis", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const hypothesisId = await insertHypothesis(investigationId, orgA, ownerA);

    const invalid = await apiRequest(
      server.url,
      "PATCH",
      `/investigations/${investigationId}/hypotheses/${hypothesisId}`,
      { ...auth(ownerA, orgA), body: { status: "maybe" } }
    );
    const unknown = await apiRequest(
      server.url,
      "PATCH",
      `/investigations/${investigationId}/hypotheses/${randomUUID()}`,
      { ...auth(ownerA, orgA), body: { status: "rejected" } }
    );

    assert.equal(invalid.status, 400);
    assert.equal(unknown.status, 404);

    const stored = await getPool().query<{ status: string }>(
      `SELECT status FROM investigation_hypotheses WHERE id = $1`,
      [hypothesisId]
    );
    assert.equal(stored.rows[0]!.status, "unverified", "a refused verdict changes nothing");
  });

  it("does not let another organization record a verdict on a foreign hypothesis", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const hypothesisId = await insertHypothesis(investigationId, orgA, ownerA);

    const response = await apiRequest(
      server.url,
      "PATCH",
      `/investigations/${investigationId}/hypotheses/${hypothesisId}`,
      { ...auth(ownerB, orgB), body: { status: "rejected" } }
    );

    assert.equal(response.status, 404);

    const stored = await getPool().query<{ status: string; status_source: string }>(
      `SELECT status, status_source FROM investigation_hypotheses WHERE id = $1`,
      [hypothesisId]
    );
    assert.deepEqual(stored.rows[0], {
      status: "unverified",
      status_source: "model",
    });
  });
});
