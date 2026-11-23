import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InvestigationConflictError,
  InvestigationNotFoundError,
  InvestigationValidationError,
} from "../investigations/errors.js";
import {
  applyActionItemStatusChange,
  assertActionItemStatusTransition,
  normalizeActionItemId,
  validateCreateActionItem,
  validateListActionItemsQuery,
  validateUpdateActionItem,
} from "./policy.js";
import type { ActionItemLifecycleState } from "./policy.js";

const NOW = "2026-11-23T10:00:00.000Z";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ANALYSIS_ID = "33333333-3333-4333-8333-333333333333";
const HYPOTHESIS_ID = "44444444-4444-4444-8444-444444444444";

function createPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    title: "Roll back the checkout deployment",
    ...overrides,
  };
}

function state(
  overrides: Partial<ActionItemLifecycleState> = {}
): ActionItemLifecycleState {
  return {
    status: "open",
    blockedReason: null,
    completedAt: null,
    completedBy: null,
    ...overrides,
  };
}

describe("validateCreateActionItem", () => {
  it("accepts a bare title and applies documented defaults", () => {
    const parsed = validateCreateActionItem(createPayload());

    assert.equal(parsed.title, "Roll back the checkout deployment");
    assert.equal(parsed.description, null);
    assert.equal(parsed.priority, "medium");
    assert.equal(parsed.assigneeUserId, null);
    assert.equal(parsed.dueAt, null);
    assert.equal(parsed.createdFrom, "manual");
    assert.equal(parsed.sourceAnalysisId, null);
    assert.equal(parsed.sourceHypothesisId, null);
    assert.equal(parsed.sourceLabel, null);
  });

  it("trims text and normalises timestamps", () => {
    const parsed = validateCreateActionItem(
      createPayload({
        title: "   Check the connection pool   ",
        description: "  Confirm the pool is not exhausted.  ",
        dueAt: "2026-11-24T09:00:00+02:00",
      })
    );

    assert.equal(parsed.title, "Check the connection pool");
    assert.equal(parsed.description, "Confirm the pool is not exhausted.");
    assert.equal(parsed.dueAt, "2026-11-24T07:00:00.000Z");
  });

  it("rejects out-of-range text and an invalid due date", () => {
    assert.throws(
      () => validateCreateActionItem(createPayload({ title: "ab" })),
      InvestigationValidationError
    );
    assert.throws(
      () => validateCreateActionItem(createPayload({ title: "x".repeat(201) })),
      InvestigationValidationError
    );
    assert.throws(
      () =>
        validateCreateActionItem(
          createPayload({ description: "x".repeat(4001) })
        ),
      InvestigationValidationError
    );
    assert.throws(
      () => validateCreateActionItem(createPayload({ dueAt: "tomorrow" })),
      InvestigationValidationError
    );
  });

  it("rejects an unknown priority or createdFrom value", () => {
    assert.throws(
      () => validateCreateActionItem(createPayload({ priority: "urgent" })),
      InvestigationValidationError
    );
    assert.throws(
      () => validateCreateActionItem(createPayload({ createdFrom: "model" })),
      InvestigationValidationError
    );
  });

  it("rejects provenance on a manually written item", () => {
    for (const overrides of [
      { sourceAnalysisId: ANALYSIS_ID },
      { sourceHypothesisId: HYPOTHESIS_ID },
      { sourceLabel: "A suggestion" },
    ]) {
      assert.throws(
        () =>
          validateCreateActionItem(
            createPayload({ createdFrom: "manual", ...overrides })
          ),
        InvestigationValidationError
      );
    }
  });

  it("requires a source and a label for an analysis-derived item", () => {
    assert.throws(
      () =>
        validateCreateActionItem(
          createPayload({
            createdFrom: "analysis",
            sourceLabel: "Suggested next step",
          })
        ),
      (error: unknown) =>
        error instanceof InvestigationValidationError &&
        /source analysis or hypothesis/i.test(error.message)
    );

    assert.throws(
      () =>
        validateCreateActionItem(
          createPayload({
            createdFrom: "analysis",
            sourceAnalysisId: ANALYSIS_ID,
          })
        ),
      (error: unknown) =>
        error instanceof InvestigationValidationError &&
        /source label/i.test(error.message)
    );
  });

  it("accepts an analysis-derived item with a snapshot label", () => {
    const parsed = validateCreateActionItem(
      createPayload({
        createdFrom: "analysis",
        sourceAnalysisId: ANALYSIS_ID,
        sourceLabel: "Check whether the pool limit was raised.",
      })
    );

    assert.equal(parsed.createdFrom, "analysis");
    assert.equal(parsed.sourceAnalysisId, ANALYSIS_ID);
    assert.equal(parsed.sourceLabel, "Check whether the pool limit was raised.");
  });
});

describe("validateUpdateActionItem", () => {
  it("parses editable fields and clears empty text", () => {
    const parsed = validateUpdateActionItem({
      title: "  Updated title  ",
      description: "   ",
      priority: "critical",
      assigneeUserId: USER_ID,
      dueAt: "2026-11-25T00:00:00Z",
      status: "in_progress",
      expectedUpdatedAt: NOW,
    });

    assert.equal(parsed.title, "Updated title");
    assert.equal(parsed.description, null);
    assert.equal(parsed.priority, "critical");
    assert.equal(parsed.assigneeUserId, USER_ID);
    assert.equal(parsed.dueAt, "2026-11-25T00:00:00.000Z");
    assert.equal(parsed.status, "in_progress");
    assert.equal(parsed.expectedUpdatedAt, NOW);
  });

  it("treats null and empty assignee or due date as clearing", () => {
    const parsed = validateUpdateActionItem({
      assigneeUserId: "",
      dueAt: "",
      blockedReason: "",
    });

    assert.equal(parsed.assigneeUserId, null);
    assert.equal(parsed.dueAt, null);
    assert.equal(parsed.blockedReason, null);
  });

  it("rejects an update with no supported fields", () => {
    assert.throws(
      () => validateUpdateActionItem({}),
      (error: unknown) =>
        error instanceof InvestigationValidationError &&
        /no supported fields/i.test(error.message)
    );
  });

  it("rejects attempts to rewrite provenance", () => {
    for (const field of [
      "createdFrom",
      "sourceAnalysisId",
      "sourceHypothesisId",
      "sourceLabel",
    ]) {
      assert.throws(
        () => validateUpdateActionItem({ [field]: null }),
        (error: unknown) =>
          error instanceof InvestigationValidationError &&
          /immutable/i.test(error.message)
      );
    }
  });

  it("rejects malformed ids and statuses", () => {
    assert.throws(
      () => validateUpdateActionItem({ assigneeUserId: "me" }),
      InvestigationValidationError
    );
    assert.throws(
      () => validateUpdateActionItem({ status: "done" }),
      InvestigationValidationError
    );
  });
});

describe("action item lifecycle", () => {
  it("allows only the documented transitions", () => {
    assert.doesNotThrow(() => assertActionItemStatusTransition("open", "open"));
    assert.doesNotThrow(() =>
      assertActionItemStatusTransition("open", "in_progress")
    );
    assert.doesNotThrow(() =>
      assertActionItemStatusTransition("blocked", "completed")
    );
    assert.doesNotThrow(() =>
      assertActionItemStatusTransition("completed", "open")
    );

    assert.throws(
      () => assertActionItemStatusTransition("completed", "in_progress"),
      InvestigationConflictError
    );
    assert.throws(
      () => assertActionItemStatusTransition("completed", "blocked"),
      InvestigationConflictError
    );
  });

  it("requires a reason to become blocked", () => {
    assert.throws(
      () =>
        applyActionItemStatusChange({
          current: state({ status: "in_progress" }),
          request: { status: "blocked" },
          now: NOW,
          actorUserId: USER_ID,
        }),
      (error: unknown) =>
        error instanceof InvestigationValidationError &&
        /blocked reason/i.test(error.message)
    );

    const result = applyActionItemStatusChange({
      current: state({ status: "in_progress" }),
      request: { status: "blocked", blockedReason: "  Waiting on access  " },
      now: NOW,
      actorUserId: USER_ID,
    });

    assert.equal(result.state.status, "blocked");
    assert.equal(result.state.blockedReason, "Waiting on access");
  });

  it("clears the reason when leaving blocked and keeps it in the result", () => {
    const result = applyActionItemStatusChange({
      current: state({
        status: "blocked",
        blockedReason: "Waiting on access",
      }),
      request: { status: "in_progress" },
      now: NOW,
      actorUserId: USER_ID,
    });

    assert.equal(result.state.status, "in_progress");
    assert.equal(result.state.blockedReason, null);
    assert.equal(result.previousBlockedReason, "Waiting on access");
  });

  it("stamps completion and clears it on reopen", () => {
    const completed = applyActionItemStatusChange({
      current: state({ status: "in_progress" }),
      request: { status: "completed" },
      now: NOW,
      actorUserId: USER_ID,
    });

    assert.equal(completed.state.status, "completed");
    assert.equal(completed.state.completedAt, NOW);
    assert.equal(completed.state.completedBy, USER_ID);

    const reopened = applyActionItemStatusChange({
      current: completed.state,
      request: { status: "open" },
      now: "2026-11-23T11:00:00.000Z",
      actorUserId: OTHER_ID,
    });

    assert.equal(reopened.state.status, "open");
    assert.equal(reopened.state.completedAt, null);
    assert.equal(reopened.state.completedBy, null);
  });

  it("allows editing the reason while the item stays blocked", () => {
    const result = applyActionItemStatusChange({
      current: state({
        status: "blocked",
        blockedReason: "Waiting on access",
      }),
      request: { blockedReason: "Waiting on the vendor" },
      now: NOW,
      actorUserId: USER_ID,
    });

    assert.equal(result.state.blockedReason, "Waiting on the vendor");
    assert.equal(result.changed, true);
  });

  it("rejects a reason on an item that is not blocked", () => {
    assert.throws(
      () =>
        applyActionItemStatusChange({
          current: state({ status: "open" }),
          request: { status: "in_progress", blockedReason: "Not applicable" },
          now: NOW,
          actorUserId: USER_ID,
        }),
      InvestigationValidationError
    );
  });

  it("rejects a direct completed-to-in_progress transition", () => {
    assert.throws(
      () =>
        applyActionItemStatusChange({
          current: state({
            status: "completed",
            completedAt: NOW,
            completedBy: USER_ID,
          }),
          request: { status: "in_progress" },
          now: NOW,
          actorUserId: USER_ID,
        }),
      InvestigationConflictError
    );
  });
});

describe("validateListActionItemsQuery", () => {
  it("applies documented pagination defaults", () => {
    const parsed = validateListActionItemsQuery({});

    assert.equal(parsed.limit, 50);
    assert.equal(parsed.offset, 0);
    assert.equal(parsed.status, undefined);
    assert.equal(parsed.priority, undefined);
    assert.equal(parsed.assignee, undefined);
  });

  it("parses status, priority and assignee filters", () => {
    const parsed = validateListActionItemsQuery({
      status: "blocked",
      priority: "high",
      assignee: "me",
      limit: "10",
      offset: "20",
    });

    assert.equal(parsed.status, "blocked");
    assert.equal(parsed.priority, "high");
    assert.deepEqual(parsed.assignee, { kind: "me" });
    assert.equal(parsed.limit, 10);
    assert.equal(parsed.offset, 20);

    assert.deepEqual(
      validateListActionItemsQuery({ assignee: "unassigned" }).assignee,
      { kind: "unassigned" }
    );
    assert.deepEqual(
      validateListActionItemsQuery({ assignee: USER_ID }).assignee,
      { kind: "user", userId: USER_ID }
    );
  });

  it("rejects an unknown assignee token and out-of-range pagination", () => {
    assert.throws(
      () => validateListActionItemsQuery({ assignee: "someone" }),
      InvestigationValidationError
    );
    assert.throws(
      () => validateListActionItemsQuery({ limit: "0" }),
      InvestigationValidationError
    );
    assert.throws(
      () => validateListActionItemsQuery({ offset: "10001" }),
      InvestigationValidationError
    );
  });
});

describe("normalizeActionItemId", () => {
  it("accepts a uuid and reports a malformed id as not found", () => {
    assert.equal(normalizeActionItemId(USER_ID), USER_ID);
    assert.throws(
      () => normalizeActionItemId("not-an-id"),
      InvestigationNotFoundError
    );
    assert.throws(
      () => normalizeActionItemId(undefined),
      InvestigationNotFoundError
    );
  });
});
