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

type Member = { userId: string; email: string; role: string };

type InvestigationBody = {
  id: string;
  title: string;
  status: string;
  ownerUserId: string | null;
  ownerEmail: string | null;
  resolutionSummary: string | null;
  updatedAt: string;
};

type ActivityEntry = {
  id: string;
  type: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
};

type DetailBody = {
  investigation: InvestigationBody;
  activity: ActivityEntry[];
  evidence: unknown[];
  collection?: unknown;
};

type ListBody = {
  investigations: InvestigationBody[];
  total: number;
};

type MembersBody = { members: Member[]; total: number };

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
  organizationId: string,
  overrides: Record<string, unknown> = {}
): Promise<DetailBody> {
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
        ...overrides,
      },
    }
  );

  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
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

describe("organization member directory", () => {
  it("is readable by a plain member and scoped to the organization", async () => {
    const response = await apiRequest<MembersBody>(
      server.url,
      "GET",
      "/organization/members",
      auth(memberA, orgA)
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.total, 2);
    assert.deepEqual(
      response.body.members.map((entry) => entry.userId).sort(),
      [ownerA, memberA].sort()
    );
  });

  it("rejects a caller who is not a member of the requested organization", async () => {
    const response = await apiRequest(
      server.url,
      "GET",
      "/organization/members",
      auth(ownerB, orgA)
    );

    assert.equal(response.status, 403);
  });

  it("keeps the admin directory owner/admin-only", async () => {
    const asMember = await apiRequest(
      server.url,
      "GET",
      "/admin/members",
      auth(memberA, orgA)
    );
    const asOwner = await apiRequest<MembersBody>(
      server.url,
      "GET",
      "/admin/members",
      auth(ownerA, orgA)
    );

    assert.equal(asMember.status, 403);
    assert.equal(asOwner.status, 200);
  });
});

describe("investigation ownership", () => {
  it("stores an assigned member as the owner and defaults to unassigned", async () => {
    const assigned = await createInvestigation(ownerA, orgA, { ownerUserId: memberA });
    const unassigned = await createInvestigation(ownerA, orgA);

    assert.equal(assigned.investigation.ownerUserId, memberA);
    assert.equal(assigned.investigation.ownerEmail, "member@a.example.test");
    assert.equal(unassigned.investigation.ownerUserId, null);
    assert.equal(unassigned.investigation.ownerEmail, null);
  });

  it("rejects an assignee who belongs to another organization", async () => {
    const response = await apiRequest(
      server.url,
      "POST",
      "/investigations",
      {
        ...auth(ownerA, orgA),
        body: {
          title: "Assign to an outsider",
          description: "This request must be rejected by membership validation.",
          ownerUserId: ownerB,
        },
      }
    );

    assert.equal(response.status, 400);
    assert.match(
      (response.body as { error: string }).error,
      /not a member of this organization/i
    );
  });

  it("filters the queue by me, unassigned and a specific member", async () => {
    await createInvestigation(ownerA, orgA, { ownerUserId: ownerA });
    await createInvestigation(ownerA, orgA, { ownerUserId: memberA });
    await createInvestigation(ownerA, orgA);

    const mine = await apiRequest<ListBody>(
      server.url,
      "GET",
      "/investigations?owner=me",
      auth(memberA, orgA)
    );
    const unassigned = await apiRequest<ListBody>(
      server.url,
      "GET",
      "/investigations?owner=unassigned",
      auth(ownerA, orgA)
    );
    const specific = await apiRequest<ListBody>(
      server.url,
      "GET",
      `/investigations?owner=${ownerA}`,
      auth(ownerA, orgA)
    );

    assert.equal(mine.status, 200);
    assert.equal(mine.body.total, 1);
    assert.equal(mine.body.investigations[0]?.ownerUserId, memberA);

    assert.equal(unassigned.body.total, 1);
    assert.equal(unassigned.body.investigations[0]?.ownerUserId, null);

    assert.equal(specific.body.total, 1);
    assert.equal(specific.body.investigations[0]?.ownerUserId, ownerA);
  });

  it("records an owner change in the activity history and allows unassigning", async () => {
    const created = await createInvestigation(ownerA, orgA);

    const assigned = await apiRequest<DetailBody>(
      server.url,
      "PATCH",
      `/investigations/${created.investigation.id}`,
      { ...auth(ownerA, orgA), body: { ownerUserId: memberA } }
    );

    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.investigation.ownerUserId, memberA);

    const change = assigned.body.activity.find((entry) => entry.type === "owner_change");
    assert.ok(change, "owner_change activity should be recorded");
    assert.equal(change?.metadata?.toUserId, memberA);
    assert.equal(change?.metadata?.fromUserId, null);

    const cleared = await apiRequest<DetailBody>(
      server.url,
      "PATCH",
      `/investigations/${created.investigation.id}`,
      { ...auth(ownerA, orgA), body: { ownerUserId: null } }
    );

    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.investigation.ownerUserId, null);
  });

  it("enforces membership at the database level as well", async () => {
    const created = await createInvestigation(ownerA, orgA);

    await assert.rejects(
      getPool().query(
        "UPDATE investigations SET owner_user_id = $1 WHERE id = $2",
        [ownerB, created.investigation.id]
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "23503"
    );
  });

  it("does not let a closed investigation change owner", async () => {
    const created = await createInvestigation(ownerA, orgA);

    await apiRequest(server.url, "PATCH", `/investigations/${created.investigation.id}`, {
      ...auth(ownerA, orgA),
      body: { status: "closed" },
    });

    const response = await apiRequest(
      server.url,
      "PATCH",
      `/investigations/${created.investigation.id}`,
      { ...auth(ownerA, orgA), body: { ownerUserId: memberA } }
    );

    assert.equal(response.status, 409);
  });
});

describe("investigation lifecycle", () => {
  it("rejects an invalid transition and a resolution without a summary", async () => {
    const created = await createInvestigation(ownerA, orgA);
    const id = created.investigation.id;

    const openToResolved = await apiRequest(
      server.url,
      "PATCH",
      `/investigations/${id}`,
      {
        ...auth(ownerA, orgA),
        body: { status: "resolved", resolutionSummary: "Not allowed from open." },
      }
    );

    const started = await apiRequest<DetailBody>(
      server.url,
      "PATCH",
      `/investigations/${id}`,
      { ...auth(ownerA, orgA), body: { status: "investigating" } }
    );

    const withoutSummary = await apiRequest(
      server.url,
      "PATCH",
      `/investigations/${id}`,
      { ...auth(ownerA, orgA), body: { status: "resolved" } }
    );

    assert.equal(openToResolved.status, 409);
    assert.equal(started.status, 200);
    assert.equal(started.body.investigation.status, "investigating");
    assert.equal(withoutSummary.status, 400);
  });

  it("resolves, closes, refuses metadata edits and reopens", async () => {
    const created = await createInvestigation(ownerA, orgA);
    const id = created.investigation.id;

    await apiRequest(server.url, "PATCH", `/investigations/${id}`, {
      ...auth(ownerA, orgA),
      body: { status: "investigating" },
    });

    const resolved = await apiRequest<DetailBody>(
      server.url,
      "PATCH",
      `/investigations/${id}`,
      {
        ...auth(ownerA, orgA),
        body: {
          status: "resolved",
          resolutionSummary: "Raised the pool limit and terminated idle transactions.",
        },
      }
    );

    const closed = await apiRequest<DetailBody>(
      server.url,
      "PATCH",
      `/investigations/${id}`,
      { ...auth(ownerA, orgA), body: { status: "closed" } }
    );

    const editClosed = await apiRequest(
      server.url,
      "PATCH",
      `/investigations/${id}`,
      { ...auth(ownerA, orgA), body: { title: "Rewritten after the fact" } }
    );

    const reopened = await apiRequest<DetailBody>(
      server.url,
      "PATCH",
      `/investigations/${id}`,
      { ...auth(ownerA, orgA), body: { status: "investigating" } }
    );

    const editReopened = await apiRequest<DetailBody>(
      server.url,
      "PATCH",
      `/investigations/${id}`,
      { ...auth(ownerA, orgA), body: { title: "Rewritten after reopening" } }
    );

    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.investigation.status, "resolved");
    assert.equal(closed.status, 200);
    assert.equal(closed.body.investigation.status, "closed");
    assert.equal(editClosed.status, 409);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.investigation.status, "investigating");
    assert.equal(reopened.body.investigation.resolutionSummary, null);
    assert.equal(editReopened.status, 200);
    assert.equal(
      editReopened.body.investigation.title,
      "Rewritten after reopening"
    );
  });

  it("rejects a stale optimistic-concurrency token", async () => {
    const created = await createInvestigation(ownerA, orgA);

    const response = await apiRequest(
      server.url,
      "PATCH",
      `/investigations/${created.investigation.id}`,
      {
        ...auth(ownerA, orgA),
        body: {
          title: "Concurrent edit",
          expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
        },
      }
    );

    assert.equal(response.status, 409);
  });
});

describe("tenant isolation and authorization", () => {
  it("hides another organization's investigation as not found", async () => {
    const created = await createInvestigation(ownerA, orgA);

    const detail = await apiRequest(
      server.url,
      "GET",
      `/investigations/${created.investigation.id}`,
      auth(ownerB, orgB)
    );
    const list = await apiRequest<ListBody>(
      server.url,
      "GET",
      "/investigations",
      auth(ownerB, orgB)
    );

    assert.equal(detail.status, 404);
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 0);
  });

  it("requires authentication", async () => {
    const response = await apiRequest(server.url, "GET", "/investigations");

    assert.equal(response.status, 401);
  });

  it("rejects malformed owner ids and unknown statuses", async () => {
    const badOwner = await apiRequest(server.url, "POST", "/investigations", {
      ...auth(ownerA, orgA),
      body: {
        title: "Malformed owner",
        description: "The owner filter accepts a uuid, me or unassigned only.",
        ownerUserId: "me",
      },
    });

    const badStatus = await apiRequest(server.url, "GET", "/investigations?status=done", auth(ownerA, orgA));

    assert.equal(badOwner.status, 400);
    assert.equal(badStatus.status, 400);
  });
});
