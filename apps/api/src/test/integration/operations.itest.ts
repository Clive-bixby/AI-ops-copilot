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

type InvestigationBody = {
  investigation: { id: string; status: string };
};

type ActionItemBody = {
  item: { id: string; status: string };
};

type OverviewBody = {
  dueSoonHours: number;
  investigations: {
    total: number;
    open: number;
    investigating: number;
    resolved: number;
    closed: number;
    assignedToMe: number;
    unassigned: number;
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
    recentlyUpdated: Array<{ id: string; title: string; ownerEmail: string | null }>;
    recentlyResolved: Array<{ id: string; title: string }>;
  };
  actionItems: {
    summary: {
      total: number;
      open: number;
      inProgress: number;
      blocked: number;
      completed: number;
      overdue: number;
      dueSoon: number;
      assignedToMe: number;
      unassigned: number;
    };
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
    recentlyCompleted: Array<{
      id: string;
      title: string;
      investigationId: string;
      investigationTitle: string;
    }>;
  };
};

type QueueBody = {
  items: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    assigneeEmail: string | null;
    investigationId: string;
    investigationTitle: string;
  }>;
  summary: OverviewBody["actionItems"]["summary"];
  total: number;
  limit: number;
  offset: number;
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
  organizationId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const response = await apiRequest<InvestigationBody>(
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
  return response.body.investigation.id;
}

async function patchInvestigation(
  userId: string,
  organizationId: string,
  investigationId: string,
  body: Record<string, unknown>
): Promise<void> {
  const response = await apiRequest(
    server.url,
    "PATCH",
    `/investigations/${investigationId}`,
    { ...auth(userId, organizationId), body }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
}

async function moveToStatus(
  userId: string,
  organizationId: string,
  investigationId: string,
  status: "investigating" | "resolved" | "closed"
): Promise<void> {
  if (status === "resolved") {
    await patchInvestigation(userId, organizationId, investigationId, {
      status: "investigating",
    });
    await patchInvestigation(userId, organizationId, investigationId, {
      status: "resolved",
      resolutionSummary:
        "Rolled back the release that introduced the new connection pool settings.",
    });
    return;
  }

  await patchInvestigation(userId, organizationId, investigationId, { status });
}

async function createActionItem(
  userId: string,
  organizationId: string,
  investigationId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const response = await apiRequest<ActionItemBody>(
    server.url,
    "POST",
    `/investigations/${investigationId}/action-items`,
    {
      ...auth(userId, organizationId),
      body: {
        title: "Follow up on the checkout deployment",
        ...overrides,
      },
    }
  );

  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.item.id;
}

async function patchActionItem(
  userId: string,
  organizationId: string,
  investigationId: string,
  actionItemId: string,
  body: Record<string, unknown>
): Promise<void> {
  const response = await apiRequest(
    server.url,
    "PATCH",
    `/investigations/${investigationId}/action-items/${actionItemId}`,
    { ...auth(userId, organizationId), body }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
}

type Seed = {
  inv1: string;
  inv2: string;
  inv3: string;
  inv4: string;
  invB: string;
  a1: string;
  a2: string;
  a3: string;
  a4: string;
  aB: string;
};

/**
 * Four investigations and four action items in organization A, one of each in
 * organization B, with a mix of statuses, priorities, assignees and due dates.
 */
async function seed(): Promise<Seed> {
  const inv1 = await createInvestigation(ownerA, orgA, {
    title: "Open investigation with an overdue item",
    ownerUserId: ownerA,
    severity: "high",
  });
  const inv2 = await createInvestigation(ownerA, orgA, {
    title: "Investigation under way",
    ownerUserId: memberA,
    severity: "low",
  });
  const inv3 = await createInvestigation(ownerA, orgA, {
    title: "Resolved investigation",
    ownerUserId: ownerA,
    severity: "critical",
  });
  const inv4 = await createInvestigation(ownerA, orgA, {
    title: "Closed investigation",
    ownerUserId: null,
    severity: "medium",
  });

  await moveToStatus(ownerA, orgA, inv2, "investigating");
  await moveToStatus(ownerA, orgA, inv3, "resolved");
  await moveToStatus(ownerA, orgA, inv4, "closed");

  const overdueAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const dueSoonAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const laterAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const a1 = await createActionItem(ownerA, orgA, inv1, {
    title: "Open item past its due date",
    priority: "medium",
    dueAt: overdueAt,
  });
  const a2 = await createActionItem(ownerA, orgA, inv1, {
    title: "Item in progress and due soon",
    priority: "high",
    assigneeUserId: memberA,
    dueAt: dueSoonAt,
  });
  const a3 = await createActionItem(ownerA, orgA, inv2, {
    title: "Blocked item due later",
    priority: "critical",
    assigneeUserId: memberA,
    dueAt: laterAt,
  });
  const a4 = await createActionItem(ownerA, orgA, inv2, {
    title: "Completed item",
    priority: "low",
    assigneeUserId: ownerA,
  });

  await patchActionItem(ownerA, orgA, inv1, a2, { status: "in_progress" });
  await patchActionItem(ownerA, orgA, inv2, a3, {
    status: "blocked",
    blockedReason: "Waiting on the vendor",
  });
  await patchActionItem(ownerA, orgA, inv2, a4, { status: "completed" });

  const invB = await createInvestigation(ownerB, orgB, {
    title: "Another organization's investigation",
    severity: "high",
  });
  const aB = await createActionItem(ownerB, orgB, invB, {
    title: "Another organization's item",
  });

  return { inv1, inv2, inv3, inv4, invB, a1, a2, a3, a4, aB };
}

async function overview(
  userId: string,
  organizationId: string
): Promise<QueueResponse<OverviewBody>> {
  return apiRequest<OverviewBody>(
    server.url,
    "GET",
    "/insights/operations",
    auth(userId, organizationId)
  );
}

async function queue(
  userId: string,
  organizationId: string,
  query = ""
): Promise<QueueResponse<QueueBody>> {
  return apiRequest<QueueBody>(
    server.url,
    "GET",
    `/insights/action-items${query}`,
    auth(userId, organizationId)
  );
}

type QueueResponse<T> = { status: number; body: T };

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

describe("operations overview", () => {
  it("counts investigations, ownership and action items exactly", async () => {
    const seeded = await seed();
    const response = await overview(ownerA, orgA);

    assert.equal(response.status, 200);

    const investigations = response.body.investigations;
    assert.equal(investigations.total, 4);
    assert.equal(investigations.open, 1);
    assert.equal(investigations.investigating, 1);
    assert.equal(investigations.resolved, 1);
    assert.equal(investigations.closed, 1);
    assert.equal(investigations.assignedToMe, 2);
    assert.equal(investigations.unassigned, 1);
    assert.deepEqual(investigations.byStatus, {
      open: 1,
      investigating: 1,
      resolved: 1,
      closed: 1,
    });
    assert.deepEqual(investigations.bySeverity, {
      low: 1,
      medium: 1,
      high: 1,
      critical: 1,
    });
    assert.equal(investigations.recentlyUpdated.length, 4);
    assert.equal(investigations.recentlyResolved.length, 1);
    assert.equal(investigations.recentlyResolved[0]?.id, seeded.inv3);
    assert.ok(
      investigations.recentlyUpdated.some(
        (item) => item.ownerEmail === "member@a.example.test"
      )
    );

    assert.deepEqual(response.body.actionItems.summary, {
      total: 4,
      open: 1,
      inProgress: 1,
      blocked: 1,
      completed: 1,
      overdue: 1,
      dueSoon: 1,
      assignedToMe: 1,
      unassigned: 1,
    });
    assert.deepEqual(response.body.actionItems.byStatus, {
      open: 1,
      in_progress: 1,
      blocked: 1,
      completed: 1,
    });
    assert.deepEqual(response.body.actionItems.byPriority, {
      low: 1,
      medium: 1,
      high: 1,
      critical: 1,
    });
    assert.equal(response.body.actionItems.recentlyCompleted.length, 1);
    assert.equal(
      response.body.actionItems.recentlyCompleted[0]?.id,
      seeded.a4
    );
    assert.equal(
      response.body.actionItems.recentlyCompleted[0]?.investigationId,
      seeded.inv2
    );
    assert.ok(
      response.body.actionItems.recentlyCompleted[0]?.investigationTitle
    );
  });

  it("never counts another organization's records", async () => {
    await seed();

    const response = await overview(ownerB, orgB);

    assert.equal(response.status, 200);
    assert.equal(response.body.investigations.total, 1);
    assert.equal(response.body.investigations.open, 1);
    assert.equal(response.body.investigations.assignedToMe, 0);
    assert.equal(response.body.investigations.unassigned, 1);
    assert.equal(response.body.actionItems.summary.total, 1);
    assert.equal(response.body.actionItems.summary.open, 1);
    assert.equal(response.body.actionItems.recentlyCompleted.length, 0);
  });

  it("requires authentication and an active organization", async () => {
    const anonymous = await apiRequest(server.url, "GET", "/insights/operations");
    const noOrganization = await apiRequest(
      server.url,
      "GET",
      "/insights/operations",
      { token: tokenFor(ownerA) }
    );

    assert.equal(anonymous.status, 401);
    assert.equal(noOrganization.status, 400);
  });
});

describe("operations action-item queue", () => {
  it("lists every item with its investigation and an unfiltered summary", async () => {
    const seeded = await seed();
    const response = await queue(ownerA, orgA);

    assert.equal(response.status, 200);
    assert.equal(response.body.total, 4);
    assert.equal(response.body.items.length, 4);
    assert.deepEqual(
      response.body.items.map((item) => item.id),
      [seeded.a1, seeded.a2, seeded.a3, seeded.a4]
    );
    assert.equal(
      response.body.items.find((item) => item.id === seeded.a3)
        ?.investigationTitle,
      "Investigation under way"
    );
    assert.equal(response.body.summary.total, 4);
  });

  it("applies status, priority, assignee, due and investigation filters", async () => {
    const seeded = await seed();

    const blocked = await queue(ownerA, orgA, "?status=blocked");
    const critical = await queue(ownerA, orgA, "?priority=critical");
    const mine = await queue(memberA, orgA, "?assignee=me");
    const unassigned = await queue(ownerA, orgA, "?assignee=unassigned");
    const overdue = await queue(ownerA, orgA, "?due=overdue");
    const dueSoon = await queue(ownerA, orgA, "?due=due_soon");
    const byInvestigation = await queue(
      ownerA,
      orgA,
      `?investigationId=${seeded.inv2}`
    );

    assert.deepEqual(
      blocked.body.items.map((item) => item.id),
      [seeded.a3]
    );
    assert.deepEqual(
      critical.body.items.map((item) => item.id),
      [seeded.a3]
    );
    assert.deepEqual(
      mine.body.items.map((item) => item.id).sort(),
      [seeded.a2, seeded.a3].sort()
    );
    assert.deepEqual(
      unassigned.body.items.map((item) => item.id),
      [seeded.a1]
    );
    assert.deepEqual(
      overdue.body.items.map((item) => item.id),
      [seeded.a1]
    );
    assert.deepEqual(
      dueSoon.body.items.map((item) => item.id),
      [seeded.a2]
    );
    assert.deepEqual(
      byInvestigation.body.items.map((item) => item.id).sort(),
      [seeded.a3, seeded.a4].sort()
    );

    // The summary describes the organization, not the filtered page.
    assert.equal(blocked.body.summary.total, 4);
    assert.equal(overdue.body.total, 1);
    assert.equal(overdue.body.summary.overdue, 1);
  });

  it("paginates in SQL while reporting the filtered total", async () => {
    const seeded = await seed();

    const page = await queue(ownerA, orgA, "?limit=2&offset=2");

    assert.equal(page.status, 200);
    assert.equal(page.body.total, 4);
    assert.equal(page.body.limit, 2);
    assert.equal(page.body.offset, 2);
    assert.deepEqual(
      page.body.items.map((item) => item.id),
      [seeded.a3, seeded.a4]
    );
  });

  it("hides another organization's queue", async () => {
    await seed();

    const response = await queue(ownerB, orgB);

    assert.equal(response.status, 200);
    assert.equal(response.body.total, 1);
    assert.equal(response.body.items.length, 1);
    assert.equal(response.body.summary.total, 1);

    const crossOrgItems = await getPool().query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM action_items WHERE organization_id = $1",
      [orgA]
    );
    assert.equal(crossOrgItems.rows[0]?.count, 4);
  });

  it("rejects malformed filters instead of ignoring them", async () => {
    await seed();

    const badStatus = await queue(ownerA, orgA, "?status=done");
    const badAssignee = await queue(ownerA, orgA, "?assignee=someone");
    const badDue = await queue(ownerA, orgA, "?due=soon");
    const badInvestigation = await queue(
      ownerA,
      orgA,
      "?investigationId=not-an-id"
    );
    const badLimit = await queue(ownerA, orgA, "?limit=0");

    assert.equal(badStatus.status, 400);
    assert.equal(badAssignee.status, 400);
    assert.equal(badDue.status, 400);
    assert.equal(badInvestigation.status, 400);
    assert.equal(badLimit.status, 400);
  });
});
