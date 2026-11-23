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
  id: string;
  status: string;
};

type ActionItemBody = {
  id: string;
  investigationId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeUserId: string | null;
  assigneeEmail: string | null;
  dueAt: string | null;
  blockedReason: string | null;
  completedAt: string | null;
  completedBy: string | null;
  createdFrom: string;
  sourceAnalysisId: string | null;
  sourceHypothesisId: string | null;
  sourceLabel: string | null;
  createdByEmail: string | null;
  updatedAt: string;
};

type ActionItemEventBody = {
  id: string;
  type: string;
  actorEmail: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
};

type ActionItemDetailBody = {
  item: ActionItemBody;
  events: ActionItemEventBody[];
};

type ActionItemListBody = {
  items: ActionItemBody[];
  summary: {
    total: number;
    open: number;
    inProgress: number;
    blocked: number;
    completed: number;
    overdue: number;
  };
};

type DetailBody = {
  investigation: InvestigationBody;
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
  return response.body.investigation.id;
}

async function createActionItem(
  userId: string,
  organizationId: string,
  investigationId: string,
  overrides: Record<string, unknown> = {}
): Promise<ActionItemDetailBody> {
  const response = await apiRequest<ActionItemDetailBody>(
    server.url,
    "POST",
    `/investigations/${investigationId}/action-items`,
    {
      ...auth(userId, organizationId),
      body: {
        title: "Roll back the checkout deployment",
        ...overrides,
      },
    }
  );

  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

async function patchActionItem(
  userId: string,
  organizationId: string,
  investigationId: string,
  actionItemId: string,
  body: Record<string, unknown>
) {
  return apiRequest<ActionItemDetailBody>(
    server.url,
    "PATCH",
    `/investigations/${investigationId}/action-items/${actionItemId}`,
    { ...auth(userId, organizationId), body }
  );
}

async function listActionItems(
  userId: string,
  organizationId: string,
  investigationId: string,
  query = ""
) {
  return apiRequest<ActionItemListBody>(
    server.url,
    "GET",
    `/investigations/${investigationId}/action-items${query}`,
    auth(userId, organizationId)
  );
}

async function insertAnalysis(
  investigationId: string,
  organizationId: string,
  userId: string
): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO investigation_analyses (
       investigation_id, organization_id, status, analysis_version, provider, model, created_by
     )
     VALUES ($1, $2, 'succeeded', 1, 'test', 'test-model', $3)
     RETURNING id`,
    [investigationId, organizationId, userId]
  );

  return result.rows[0]!.id;
}

async function insertHypothesis(
  investigationId: string,
  organizationId: string,
  userId: string,
  analysisId: string
): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO investigation_hypotheses (
       investigation_id, organization_id, statement, rationale, statement_hash,
       analysis_id, created_by
     )
     VALUES ($1, $2, 'The connection pool is exhausted', 'Observed waits', $3, $4, $5)
     RETURNING id`,
    [investigationId, organizationId, `hash-${Date.now()}-${Math.random()}`, analysisId, userId]
  );

  return result.rows[0]!.id;
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

describe("action item creation", () => {
  it("creates a manual item with defaults, assignment and creation history", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);

    const created = await createActionItem(ownerA, orgA, investigationId, {
      title: "  Roll back the checkout deployment  ",
      description: "Revert the release that introduced the new pool settings.",
      priority: "high",
      assigneeUserId: memberA,
      dueAt: "2026-11-25T09:00:00Z",
    });

    assert.equal(created.item.title, "Roll back the checkout deployment");
    assert.equal(created.item.status, "open");
    assert.equal(created.item.priority, "high");
    assert.equal(created.item.assigneeUserId, memberA);
    assert.equal(created.item.assigneeEmail, "member@a.example.test");
    assert.equal(created.item.createdFrom, "manual");
    assert.equal(created.item.sourceAnalysisId, null);
    assert.equal(created.item.sourceLabel, null);
    assert.equal(created.item.createdByEmail, "owner@a.example.test");
    assert.equal(created.events.length, 1);
    assert.equal(created.events[0]?.type, "created");
    assert.equal(created.events[0]?.actorEmail, "owner@a.example.test");

    const list = await listActionItems(ownerA, orgA, investigationId);

    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.summary.total, 1);
    assert.equal(list.body.summary.open, 1);
  });

  it("defaults to unassigned and medium priority", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const created = await createActionItem(ownerA, orgA, investigationId);

    assert.equal(created.item.assigneeUserId, null);
    assert.equal(created.item.priority, "medium");
    assert.equal(created.item.dueAt, null);
  });

  it("rejects an assignee who belongs to another organization", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);

    const response = await apiRequest(
      server.url,
      "POST",
      `/investigations/${investigationId}/action-items`,
      {
        ...auth(ownerA, orgA),
        body: {
          title: "Assign to an outsider",
          assigneeUserId: ownerB,
        },
      }
    );

    assert.equal(response.status, 400);
    assert.match(
      (response.body as { error: string }).error,
      /not a member of this organization/i
    );
  });

  it("does not allow a new item on a closed investigation but still completes an existing one", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const existing = await createActionItem(ownerA, orgA, investigationId);

    const closed = await apiRequest(
      server.url,
      "PATCH",
      `/investigations/${investigationId}`,
      { ...auth(ownerA, orgA), body: { status: "closed" } }
    );

    const rejected = await apiRequest(
      server.url,
      "POST",
      `/investigations/${investigationId}/action-items`,
      {
        ...auth(ownerA, orgA),
        body: { title: "Created after the investigation closed" },
      }
    );

    const completed = await patchActionItem(
      ownerA,
      orgA,
      investigationId,
      existing.item.id,
      { status: "completed" }
    );

    assert.equal(closed.status, 200);
    assert.equal(rejected.status, 409);
    assert.equal(completed.status, 200);
    assert.equal(completed.body.item.status, "completed");
    assert.ok(completed.body.item.completedAt);
    assert.equal(completed.body.item.completedBy, ownerA);
  });
});

describe("action item lifecycle", () => {
  it("moves through in_progress, blocked, completed and reopened", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const created = await createActionItem(ownerA, orgA, investigationId);
    const id = created.item.id;

    const started = await patchActionItem(ownerA, orgA, investigationId, id, {
      status: "in_progress",
    });
    const missingReason = await patchActionItem(
      ownerA,
      orgA,
      investigationId,
      id,
      { status: "blocked" }
    );
    const blocked = await patchActionItem(ownerA, orgA, investigationId, id, {
      status: "blocked",
      blockedReason: "Waiting on the on-call engineer",
    });
    const completed = await patchActionItem(ownerA, orgA, investigationId, id, {
      status: "completed",
    });
    const reopened = await patchActionItem(ownerA, orgA, investigationId, id, {
      status: "open",
    });

    assert.equal(started.status, 200);
    assert.equal(started.body.item.status, "in_progress");
    assert.equal(missingReason.status, 400);
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.item.blockedReason, "Waiting on the on-call engineer");
    assert.equal(completed.status, 200);
    assert.equal(completed.body.item.status, "completed");
    assert.ok(completed.body.item.completedAt);
    assert.equal(completed.body.item.blockedReason, null);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.item.status, "open");
    assert.equal(reopened.body.item.completedAt, null);
    assert.equal(reopened.body.item.completedBy, null);

    const types = reopened.body.events.map((event) => event.type);
    assert.deepEqual(types, [
      "created",
      "status_change",
      "status_change",
      "status_change",
      "status_change",
    ]);

    const blockedEvent = reopened.body.events.find(
      (event) => event.metadata?.to === "blocked"
    );
    assert.equal(blockedEvent?.metadata?.blockedReason, "Waiting on the on-call engineer");
    assert.equal(blockedEvent?.metadata?.previousBlockedReason, null);
  });

  it("rejects an invalid transition", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const created = await createActionItem(ownerA, orgA, investigationId);

    await patchActionItem(ownerA, orgA, investigationId, created.item.id, {
      status: "completed",
    });

    const response = await patchActionItem(
      ownerA,
      orgA,
      investigationId,
      created.item.id,
      { status: "in_progress" }
    );

    assert.equal(response.status, 409);
  });

  it("updates details, assignment, priority and due date with events", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const created = await createActionItem(ownerA, orgA, investigationId);

    const updated = await patchActionItem(
      ownerA,
      orgA,
      investigationId,
      created.item.id,
      {
        title: "Check the pool limit",
        description: "Confirm the pool is not exhausted.",
        priority: "critical",
        assigneeUserId: memberA,
        dueAt: "2026-11-26T00:00:00Z",
      }
    );

    assert.equal(updated.status, 200);
    assert.equal(updated.body.item.title, "Check the pool limit");
    assert.equal(updated.body.item.priority, "critical");
    assert.equal(updated.body.item.assigneeUserId, memberA);
    assert.equal(updated.body.item.assigneeEmail, "member@a.example.test");
    assert.ok(updated.body.item.dueAt);

    const types = updated.body.events.map((event) => event.type);
    assert.ok(types.includes("details_change"));
    assert.ok(types.includes("assignee_change"));
    assert.ok(types.includes("priority_change"));
    assert.ok(types.includes("due_change"));

    const unassigned = await patchActionItem(
      ownerA,
      orgA,
      investigationId,
      created.item.id,
      { assigneeUserId: null }
    );

    assert.equal(unassigned.status, 200);
    assert.equal(unassigned.body.item.assigneeUserId, null);
    assert.ok(
      unassigned.body.events.some(
        (event) => event.type === "assignee_change" && event.body === "Action item unassigned"
      )
    );
  });

  it("rejects a stale optimistic-concurrency token", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const created = await createActionItem(ownerA, orgA, investigationId);

    const response = await patchActionItem(
      ownerA,
      orgA,
      investigationId,
      created.item.id,
      {
        title: "Concurrent edit",
        expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
      }
    );

    assert.equal(response.status, 409);
  });
});

describe("action item provenance", () => {
  it("stores analysis provenance and keeps the source label after the source is deleted", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const analysisId = await insertAnalysis(investigationId, orgA, ownerA);

    const created = await createActionItem(ownerA, orgA, investigationId, {
      title: "Check whether the pool limit was raised",
      createdFrom: "analysis",
      sourceAnalysisId: analysisId,
      sourceLabel: "Check whether the pool limit was raised.",
    });

    assert.equal(created.item.createdFrom, "analysis");
    assert.equal(created.item.sourceAnalysisId, analysisId);
    assert.equal(
      created.item.sourceLabel,
      "Check whether the pool limit was raised."
    );

    const immutable = await patchActionItem(
      ownerA,
      orgA,
      investigationId,
      created.item.id,
      { sourceLabel: "Rewritten provenance" }
    );

    assert.equal(immutable.status, 400);
    assert.match(
      (immutable.body as unknown as { error: string }).error,
      /immutable/i
    );

    await getPool().query(
      "DELETE FROM investigation_analyses WHERE id = $1",
      [analysisId]
    );

    const detail = await apiRequest<ActionItemDetailBody>(
      server.url,
      "GET",
      `/investigations/${investigationId}/action-items/${created.item.id}`,
      auth(ownerA, orgA)
    );

    assert.equal(detail.status, 200);
    assert.equal(detail.body.item.sourceAnalysisId, null);
    assert.equal(
      detail.body.item.sourceLabel,
      "Check whether the pool limit was raised."
    );
    assert.equal(detail.body.item.createdFrom, "analysis");
  });

  it("rejects a source that belongs to another investigation", async () => {
    const investigationA = await createInvestigation(ownerA, orgA);
    const investigationB = await createInvestigation(ownerA, orgA, {
      title: "A different investigation",
      description: "This one exists only to hold a foreign analysis source.",
    });
    const analysisId = await insertAnalysis(investigationB, orgA, ownerA);

    const response = await apiRequest(
      server.url,
      "POST",
      `/investigations/${investigationA}/action-items`,
      {
        ...auth(ownerA, orgA),
        body: {
          title: "Use a source from another investigation",
          createdFrom: "analysis",
          sourceAnalysisId: analysisId,
          sourceLabel: "Not this investigation",
        },
      }
    );

    assert.equal(response.status, 400);
    assert.match(
      (response.body as { error: string }).error,
      /does not belong to this investigation/i
    );
  });

  it("accepts a hypothesis source and refuses a manual item with provenance", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const analysisId = await insertAnalysis(investigationId, orgA, ownerA);
    const hypothesisId = await insertHypothesis(
      investigationId,
      orgA,
      ownerA,
      analysisId
    );

    const created = await createActionItem(ownerA, orgA, investigationId, {
      title: "Verify the hypothesis with a connection count",
      createdFrom: "analysis",
      sourceHypothesisId: hypothesisId,
      sourceLabel: "Verify the hypothesis with a connection count",
    });

    assert.equal(created.item.sourceHypothesisId, hypothesisId);

    const manual = await apiRequest(
      server.url,
      "POST",
      `/investigations/${investigationId}/action-items`,
      {
        ...auth(ownerA, orgA),
        body: {
          title: "A manual item cannot claim a source",
          sourceHypothesisId: hypothesisId,
        },
      }
    );

    assert.equal(manual.status, 400);
  });

  it("enforces provenance immutability and source scoping in the database", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const analysisA = await insertAnalysis(investigationId, orgA, ownerA);
    const analysisB = await insertAnalysis(investigationId, orgA, ownerA);

    const created = await createActionItem(ownerA, orgA, investigationId, {
      title: "Check the source analysis",
      createdFrom: "analysis",
      sourceAnalysisId: analysisA,
      sourceLabel: "Check the source analysis",
    });

    await assert.rejects(
      getPool().query(
        "UPDATE action_items SET source_analysis_id = $1 WHERE id = $2",
        [analysisB, created.item.id]
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "23514"
    );

    await assert.rejects(
      getPool().query(
        "UPDATE action_items SET source_label = 'rewritten' WHERE id = $1",
        [created.item.id]
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "23514"
    );
  });
});

describe("action item history and tenant boundaries", () => {
  it("keeps event history append-only", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const created = await createActionItem(ownerA, orgA, investigationId);
    const eventId = created.events[0]?.id;

    assert.ok(eventId);

    await assert.rejects(
      getPool().query(
        "UPDATE action_item_events SET body = 'rewritten' WHERE id = $1",
        [eventId]
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "23514"
    );
  });

  it("enforces the assignee membership at the database level", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);

    await assert.rejects(
      getPool().query(
        `INSERT INTO action_items (
           organization_id, investigation_id, title, assignee_user_id, created_by
         )
         VALUES ($1, $2, 'Cross-organization assignee', $3, $4)`,
        [orgA, investigationId, ownerB, ownerA]
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "23503"
    );
  });

  it("hides another organization's action items as not found", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);
    const created = await createActionItem(ownerA, orgA, investigationId);

    const list = await apiRequest(
      server.url,
      "GET",
      `/investigations/${investigationId}/action-items`,
      auth(ownerB, orgB)
    );
    const detail = await apiRequest(
      server.url,
      "GET",
      `/investigations/${investigationId}/action-items/${created.item.id}`,
      auth(ownerB, orgB)
    );
    const patch = await apiRequest(
      server.url,
      "PATCH",
      `/investigations/${investigationId}/action-items/${created.item.id}`,
      { ...auth(ownerB, orgB), body: { title: "Cross-tenant edit" } }
    );

    assert.equal(list.status, 404);
    assert.equal(detail.status, 404);
    assert.equal(patch.status, 404);
  });

  it("requires authentication", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);

    const response = await apiRequest(
      server.url,
      "GET",
      `/investigations/${investigationId}/action-items`
    );

    assert.equal(response.status, 401);
  });

  it("rejects malformed ids and invalid input", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);

    const badItemId = await apiRequest(
      server.url,
      "GET",
      `/investigations/${investigationId}/action-items/not-an-id`,
      auth(ownerA, orgA)
    );
    const shortTitle = await apiRequest(
      server.url,
      "POST",
      `/investigations/${investigationId}/action-items`,
      { ...auth(ownerA, orgA), body: { title: "ab" } }
    );
    const badStatus = await apiRequest(
      server.url,
      "GET",
      `/investigations/${investigationId}/action-items?status=done`,
      auth(ownerA, orgA)
    );
    const badAssignee = await apiRequest(
      server.url,
      "GET",
      `/investigations/${investigationId}/action-items?assignee=someone`,
      auth(ownerA, orgA)
    );

    assert.equal(badItemId.status, 404);
    assert.equal(shortTitle.status, 400);
    assert.equal(badStatus.status, 400);
    assert.equal(badAssignee.status, 400);
  });
});

describe("action item queue", () => {
  it("filters by status, priority and assignee and reports a summary", async () => {
    const investigationId = await createInvestigation(ownerA, orgA);

    const openPastDue = await createActionItem(ownerA, orgA, investigationId, {
      title: "Open item past its due date",
      priority: "low",
      dueAt: "2020-01-01T00:00:00Z",
    });
    const inProgress = await createActionItem(ownerA, orgA, investigationId, {
      title: "Item in progress",
      priority: "medium",
      assigneeUserId: memberA,
    });
    const blocked = await createActionItem(ownerA, orgA, investigationId, {
      title: "Blocked item",
      priority: "critical",
      assigneeUserId: memberA,
    });
    const completed = await createActionItem(ownerA, orgA, investigationId, {
      title: "Completed item",
      priority: "high",
    });

    await patchActionItem(ownerA, orgA, investigationId, inProgress.item.id, {
      status: "in_progress",
    });
    await patchActionItem(ownerA, orgA, investigationId, blocked.item.id, {
      status: "blocked",
      blockedReason: "Waiting on a vendor",
    });
    await patchActionItem(ownerA, orgA, investigationId, completed.item.id, {
      status: "completed",
    });

    const all = await listActionItems(ownerA, orgA, investigationId);
    const blockedOnly = await listActionItems(
      ownerA,
      orgA,
      investigationId,
      "?status=blocked"
    );
    const criticalOnly = await listActionItems(
      ownerA,
      orgA,
      investigationId,
      "?priority=critical"
    );
    const mine = await listActionItems(
      memberA,
      orgA,
      investigationId,
      "?assignee=me"
    );
    const unassigned = await listActionItems(
      ownerA,
      orgA,
      investigationId,
      "?assignee=unassigned"
    );

    assert.equal(all.status, 200);
    assert.deepEqual(all.body.summary, {
      total: 4,
      open: 1,
      inProgress: 1,
      blocked: 1,
      completed: 1,
      overdue: 1,
    });
    assert.equal(all.body.items.length, 4);
    assert.equal(all.body.items[0]?.id, openPastDue.item.id);

    assert.equal(blockedOnly.body.items.length, 1);
    assert.equal(blockedOnly.body.items[0]?.id, blocked.item.id);
    assert.equal(criticalOnly.body.items.length, 1);
    assert.equal(criticalOnly.body.items[0]?.id, blocked.item.id);
    assert.equal(mine.body.items.length, 2);
    assert.deepEqual(
      mine.body.items.map((item) => item.id).sort(),
      [inProgress.item.id, blocked.item.id].sort()
    );
    assert.equal(unassigned.body.items.length, 2);
  });
});
