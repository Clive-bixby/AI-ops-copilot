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

type ActivityBody = {
  id: string;
  type: string;
  actorUserId: string | null;
  actorEmail: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

type DetailBody = {
  investigation: { id: string; status: string };
  activity: ActivityBody[];
};

let server: TestServer;
let orgA: string;
let orgB: string;
let ownerA: string;
let memberA: string;
let ownerB: string;

function auth(userId: string, organizationId: string) {
  return { token: tokenFor(userId), organizationId };
}

async function createInvestigation(
  userId: string,
  organizationId: string
): Promise<string> {
  const response = await apiRequest<DetailBody>(
    server.url,
    "POST",
    "/investigations",
    {
      ...auth(userId, organizationId),
      body: {
        title: "Checkout API returns intermittent 500 responses",
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

async function postEntry(
  path: "notes" | "comments",
  userId: string,
  organizationId: string,
  investigationId: string,
  body: Record<string, unknown>
) {
  return apiRequest<{ activity: ActivityBody }>(
    server.url,
    "POST",
    `/investigations/${investigationId}/${path}`,
    { ...auth(userId, organizationId), body }
  );
}

async function getDetail(
  userId: string,
  organizationId: string,
  investigationId: string
) {
  return apiRequest<DetailBody>(
    server.url,
    "GET",
    `/investigations/${investigationId}`,
    auth(userId, organizationId)
  );
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
  memberA = await createUser("member@a.example.test");
  ownerB = await createUser("owner@b.example.test");

  await addMembership(ownerA, orgA, "owner");
  await addMembership(memberA, orgA, "member");
  await addMembership(ownerB, orgB, "owner");
});

describe("investigation discussion", () => {
  it("posts a comment attributed to the author and trims the text", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);

    const response = await postEntry("comments", memberA, orgA, investigationId, {
      body: "  Is the pool limit still 100 on the new release?  ",
    });

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.activity.type, "comment");
    assert.equal(
      response.body.activity.body,
      "Is the pool limit still 100 on the new release?"
    );
    assert.equal(response.body.activity.actorUserId, memberA);
    assert.equal(response.body.activity.actorEmail, "member@a.example.test");
  });

  it("keeps notes and comments in one chronological feed with distinct labels", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);

    await postEntry("notes", ownerA, orgA, investigationId, {
      body: "Checked pg_stat_activity; the pool is saturated.",
    });
    await postEntry("comments", memberA, orgA, investigationId, {
      body: "Can we confirm the limit before rolling back?",
    });
    await postEntry("notes", ownerA, orgA, investigationId, {
      body: "Limit confirmed at 100; the new release opened 4x more connections.",
    });

    const detail = await getDetail(ownerA, orgA, investigationId);
    const discussion = detail.body.activity.filter(
      (entry) => entry.type === "note" || entry.type === "comment"
    );

    assert.equal(detail.status, 200);
    assert.deepEqual(
      discussion.map((entry) => entry.type).sort(),
      ["comment", "note", "note"]
    );

    // The API returns newest first; a conversation reads oldest first.
    const chronological = discussion.slice().reverse();
    assert.equal(chronological[0]?.type, "note");
    assert.equal(chronological[1]?.type, "comment");
    assert.equal(chronological[2]?.type, "note");
    assert.equal(chronological[1]?.actorEmail, "member@a.example.test");
  });

  it("allows discussion after the investigation is closed", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);

    const closed = await apiRequest(
      server.url,
      "PATCH",
      `/investigations/${investigationId}`,
      { ...auth(ownerA, orgA), body: { status: "closed" } }
    );

    const response = await postEntry("comments", memberA, orgA, investigationId, {
      body: "Recording the follow-up owner before we leave this closed.",
    });

    assert.equal(closed.status, 200);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.activity.type, "comment");
  });

  it("rejects an empty, overlong or non-string comment", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);

    for (const body of [
      { body: "" },
      { body: "   " },
      { body: "x".repeat(4001) },
      { body: 42 },
      {},
    ]) {
      const response = await postEntry(
        "comments",
        ownerA,
        orgA,
        investigationId,
        body
      );

      assert.equal(response.status, 400, JSON.stringify(body));
    }
  });

  it("requires authentication", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);

    const response = await apiRequest(
      server.url,
      "POST",
      `/investigations/${investigationId}/comments`,
      { body: { body: "Anonymous comment" } }
    );

    assert.equal(response.status, 401);
  });

  it("does not let another organization comment on or read the discussion", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    await postEntry("comments", ownerA, orgA, investigationId, {
      body: "Internal discussion only.",
    });

    const post = await postEntry("comments", ownerB, orgB, investigationId, {
      body: "Cross-tenant comment",
    });
    const detail = await getDetail(ownerB, orgB, investigationId);

    assert.equal(post.status, 404);
    assert.equal(detail.status, 404);
  });

  it("treats a malformed investigation id as not found", async () => {
    const response = await postEntry(
      "comments",
      ownerA,
      orgA,
      "not-an-id",
      { body: "This cannot be stored" }
    );

    assert.equal(response.status, 404);
  });

  it("enforces a non-blank comment body in the database", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);

    await assert.rejects(
      getPool().query(
        `INSERT INTO investigation_activity (
           investigation_id, organization_id, type, actor_user_id, body
         )
         VALUES ($1, $2, 'comment', $3, '   ')`,
        [investigationId, orgA, ownerA]
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "23514"
    );
  });

  it("rejects an unknown activity type in the database", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);

    await assert.rejects(
      getPool().query(
        `INSERT INTO investigation_activity (
           investigation_id, organization_id, type, actor_user_id, body
         )
         VALUES ($1, $2, 'chat', $3, 'Not a supported type')`,
        [investigationId, orgA, ownerA]
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "23514"
    );
  });
});
