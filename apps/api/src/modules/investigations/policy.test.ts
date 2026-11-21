import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InvestigationConflictError,
  InvestigationNotFoundError,
  InvestigationValidationError,
} from "./errors.js";
import {
  applyStatusChange,
  assertStatusTransition,
  assertWindowOrder,
  normalizeInvestigationId,
  validateCreateInvestigation,
  validateListInvestigationsQuery,
  validateNoteBody,
  validateUpdateInvestigation,
} from "./policy.js";
import type { LifecycleState } from "./policy.js";

const NOW = "2026-11-21T10:00:00.000Z";

function createPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    title: "API requests intermittently return HTTP 500",
    description:
      "Since 09:40 the public API returns intermittent 500 responses for checkout.",
    ...overrides,
  };
}

function state(overrides: Partial<LifecycleState> = {}): LifecycleState {
  return {
    status: "investigating",
    resolvedAt: null,
    closedAt: null,
    resolutionSummary: null,
    ...overrides,
  };
}

describe("validateCreateInvestigation", () => {
  it("accepts a bare problem statement and applies documented defaults", () => {
    const parsed = validateCreateInvestigation(createPayload());

    assert.equal(parsed.severity, "medium");
    assert.equal(parsed.service, null);
    assert.equal(parsed.errorSignature, null);
    assert.equal(parsed.windowStart, null);
    assert.equal(parsed.windowEnd, null);
    assert.equal(parsed.sourceTypes, null);
    assert.equal(parsed.collectEvidence, false);
  });

  it("trims text fields", () => {
    const parsed = validateCreateInvestigation(
      createPayload({
        title: "   Database connections are timing out   ",
        service: "  api  ",
      })
    );

    assert.equal(parsed.title, "Database connections are timing out");
    assert.equal(parsed.service, "api");
  });

  it("normalises timestamps to ISO and keeps the supplied range", () => {
    const parsed = validateCreateInvestigation(
      createPayload({
        windowStart: "2026-11-21T09:00:00+02:00",
        windowEnd: "2026-11-21T10:00:00Z",
      })
    );

    assert.equal(parsed.windowStart, "2026-11-21T07:00:00.000Z");
    assert.equal(parsed.windowEnd, "2026-11-21T10:00:00.000Z");
  });

  it("deduplicates source preferences and treats an empty list as every source", () => {
    assert.deepEqual(
      validateCreateInvestigation(
        createPayload({ sourceTypes: ["ticket", "log", "ticket"] })
      ).sourceTypes,
      ["ticket", "log"]
    );

    assert.equal(
      validateCreateInvestigation(createPayload({ sourceTypes: [] })).sourceTypes,
      null
    );
  });

  it("rejects a body that is not an object", () => {
    for (const payload of [null, "title", 42, []]) {
      assert.throws(
        () => validateCreateInvestigation(payload),
        InvestigationValidationError
      );
    }
  });

  it("rejects out-of-range text", () => {
    assert.throws(
      () => validateCreateInvestigation(createPayload({ title: "ab" })),
      (error: unknown) =>
        error instanceof InvestigationValidationError &&
        error.message === "Title must be between 3 and 200 characters"
    );
    assert.throws(
      () => validateCreateInvestigation(createPayload({ title: "x".repeat(201) })),
      InvestigationValidationError
    );
    assert.throws(
      () => validateCreateInvestigation(createPayload({ description: "too short" })),
      InvestigationValidationError
    );
    assert.throws(
      () => validateCreateInvestigation(createPayload({ title: 42 })),
      InvestigationValidationError
    );
  });

  it("rejects unknown severities and source types instead of silently defaulting", () => {
    assert.throws(
      () => validateCreateInvestigation(createPayload({ severity: "urgent" })),
      (error: unknown) =>
        error instanceof InvestigationValidationError &&
        error.message.includes("Severity must be one of")
    );
    assert.throws(
      () => validateCreateInvestigation(createPayload({ sourceTypes: ["invoice"] })),
      (error: unknown) =>
        error instanceof InvestigationValidationError &&
        error.message === "Unsupported source type 'invoice'"
    );
    assert.throws(
      () => validateCreateInvestigation(createPayload({ sourceTypes: "log" })),
      InvestigationValidationError
    );
  });

  it("rejects a backwards or unparseable time window", () => {
    assert.throws(
      () =>
        validateCreateInvestigation(
          createPayload({
            windowStart: "2026-11-21T10:00:00Z",
            windowEnd: "2026-11-21T09:00:00Z",
          })
        ),
      (error: unknown) =>
        error instanceof InvestigationValidationError &&
        error.message === "windowEnd must be after windowStart"
    );
    assert.throws(
      () => validateCreateInvestigation(createPayload({ windowStart: "yesterday" })),
      InvestigationValidationError
    );
  });

  it("requires collectEvidence to be a boolean", () => {
    assert.equal(
      validateCreateInvestigation(createPayload({ collectEvidence: true }))
        .collectEvidence,
      true
    );
    assert.throws(
      () => validateCreateInvestigation(createPayload({ collectEvidence: "yes" })),
      InvestigationValidationError
    );
  });
});

describe("assertWindowOrder", () => {
  it("allows an open-ended window", () => {
    assert.doesNotThrow(() => assertWindowOrder(null, NOW));
    assert.doesNotThrow(() => assertWindowOrder(NOW, null));
    assert.doesNotThrow(() => assertWindowOrder(null, null));
  });

  it("rejects an end that is not strictly after the start", () => {
    assert.throws(() => assertWindowOrder(NOW, NOW), InvestigationValidationError);
    assert.throws(
      () => assertWindowOrder("2026-11-21T11:00:00Z", NOW),
      InvestigationValidationError
    );
  });
});

describe("validateUpdateInvestigation", () => {
  it("returns only the fields the client supplied", () => {
    const update = validateUpdateInvestigation({ title: "New title" });

    assert.deepEqual(update, { title: "New title" });
    assert.equal("description" in update, false);
  });

  it("accepts null to clear an optional field", () => {
    const update = validateUpdateInvestigation({ service: null });

    assert.equal(update.service, null);
  });

  it("treats an empty resolution summary as a clear", () => {
    assert.equal(
      validateUpdateInvestigation({ resolutionSummary: "" }).resolutionSummary,
      null
    );
    assert.equal(
      validateUpdateInvestigation({ resolutionSummary: "   " }).resolutionSummary,
      null
    );
  });

  it("rejects an update with nothing to change", () => {
    assert.throws(
      () => validateUpdateInvestigation({}),
      (error: unknown) =>
        error instanceof InvestigationValidationError &&
        error.message === "No supported fields to update"
    );
    // An optimistic-concurrency token alone is not a change.
    assert.throws(
      () => validateUpdateInvestigation({ expectedUpdatedAt: NOW }),
      InvestigationValidationError
    );
  });

  it("validates the status vocabulary", () => {
    assert.equal(validateUpdateInvestigation({ status: "resolved" }).status, "resolved");
    assert.throws(
      () => validateUpdateInvestigation({ status: "done" }),
      InvestigationValidationError
    );
    assert.throws(
      () => validateUpdateInvestigation({ status: null }),
      InvestigationValidationError
    );
  });

  it("validates expectedUpdatedAt as a timestamp", () => {
    assert.equal(
      validateUpdateInvestigation({ title: "A title", expectedUpdatedAt: NOW })
        .expectedUpdatedAt,
      NOW
    );
    assert.throws(
      () =>
        validateUpdateInvestigation({ title: "A title", expectedUpdatedAt: "soon" }),
      InvestigationValidationError
    );
  });
});

describe("assertStatusTransition", () => {
  it("allows the documented transitions", () => {
    assert.doesNotThrow(() => assertStatusTransition("open", "investigating"));
    assert.doesNotThrow(() => assertStatusTransition("open", "closed"));
    assert.doesNotThrow(() => assertStatusTransition("investigating", "resolved"));
    assert.doesNotThrow(() => assertStatusTransition("investigating", "closed"));
    assert.doesNotThrow(() => assertStatusTransition("resolved", "investigating"));
    assert.doesNotThrow(() => assertStatusTransition("resolved", "closed"));
    assert.doesNotThrow(() => assertStatusTransition("closed", "investigating"));
    assert.doesNotThrow(() => assertStatusTransition("open", "open"));
  });

  it("rejects everything else with a conflict", () => {
    assert.throws(
      () => assertStatusTransition("open", "resolved"),
      (error: unknown) =>
        error instanceof InvestigationConflictError &&
        error.message === "Cannot move an investigation from 'open' to 'resolved'"
    );
    assert.throws(
      () => assertStatusTransition("resolved", "open"),
      InvestigationConflictError
    );
    assert.throws(
      () => assertStatusTransition("closed", "resolved"),
      InvestigationConflictError
    );
    assert.throws(
      () => assertStatusTransition("closed", "open"),
      InvestigationConflictError
    );
  });
});

describe("applyStatusChange", () => {
  it("does nothing when no status or summary is supplied", () => {
    const result = applyStatusChange({
      current: state({ status: "open" }),
      request: {},
      now: NOW,
    });

    assert.equal(result.changed, false);
    assert.equal(result.state.status, "open");
  });

  it("resolves with a summary and a real timestamp", () => {
    const result = applyStatusChange({
      current: state(),
      request: {
        status: "resolved",
        resolutionSummary: "Raised PGPOOL_MAX and terminated idle transactions.",
      },
      now: NOW,
    });

    assert.equal(result.state.status, "resolved");
    assert.equal(result.state.resolvedAt, NOW);
    assert.equal(result.state.closedAt, null);
    assert.equal(
      result.state.resolutionSummary,
      "Raised PGPOOL_MAX and terminated idle transactions."
    );
  });

  it("refuses to resolve without a summary", () => {
    assert.throws(
      () =>
        applyStatusChange({
          current: state(),
          request: { status: "resolved" },
          now: NOW,
        }),
      (error: unknown) =>
        error instanceof InvestigationValidationError &&
        error.message === "Resolving an investigation requires a resolution summary"
    );

    assert.throws(
      () =>
        applyStatusChange({
          current: state(),
          request: { status: "resolved", resolutionSummary: "   " },
          now: NOW,
        }),
      InvestigationValidationError
    );
  });

  it("refuses to resolve straight from open", () => {
    assert.throws(
      () =>
        applyStatusChange({
          current: state({ status: "open" }),
          request: {
            status: "resolved",
            resolutionSummary: "Fixed the config.",
          },
          now: NOW,
        }),
      InvestigationConflictError
    );
  });

  it("keeps the resolution time when a resolved investigation is closed", () => {
    const resolved = state({
      status: "resolved",
      resolvedAt: "2026-11-21T09:00:00.000Z",
      resolutionSummary: "Restarted the gateway client.",
    });

    const result = applyStatusChange({
      current: resolved,
      request: { status: "closed" },
      now: NOW,
    });

    assert.equal(result.state.status, "closed");
    assert.equal(result.state.closedAt, NOW);
    assert.equal(result.state.resolvedAt, "2026-11-21T09:00:00.000Z");
    assert.equal(result.state.resolutionSummary, "Restarted the gateway client.");
  });

  it("closes without inventing a resolution", () => {
    const result = applyStatusChange({
      current: state(),
      request: { status: "closed" },
      now: NOW,
    });

    assert.equal(result.state.status, "closed");
    assert.equal(result.state.resolvedAt, null);
    assert.equal(result.state.resolutionSummary, null);
  });

  it("clears the resolution on reopen and reports the previous summary", () => {
    const resolved = state({
      status: "resolved",
      resolvedAt: "2026-11-21T09:00:00.000Z",
      resolutionSummary: "Restarted the gateway client.",
    });

    const result = applyStatusChange({
      current: resolved,
      request: { status: "investigating" },
      now: NOW,
    });

    assert.equal(result.state.status, "investigating");
    assert.equal(result.state.resolvedAt, null);
    assert.equal(result.state.closedAt, null);
    assert.equal(result.state.resolutionSummary, null);
    assert.equal(
      result.previousResolutionSummary,
      "Restarted the gateway client."
    );
  });

  it("updates the summary of an already-resolved investigation", () => {
    const resolved = state({
      status: "resolved",
      resolvedAt: "2026-11-21T09:00:00.000Z",
      resolutionSummary: "Restarted the gateway client.",
    });

    const result = applyStatusChange({
      current: resolved,
      request: { resolutionSummary: "Restarted the client and cleared the retry queue." },
      now: NOW,
    });

    assert.equal(result.changed, true);
    assert.equal(result.state.resolvedAt, "2026-11-21T09:00:00.000Z");
    assert.equal(
      result.state.resolutionSummary,
      "Restarted the client and cleared the retry queue."
    );
  });

  it("refuses a summary on an investigation that is not resolved", () => {
    assert.throws(
      () =>
        applyStatusChange({
          current: state(),
          request: { resolutionSummary: "Looks fixed to me." },
          now: NOW,
        }),
      (error: unknown) =>
        error instanceof InvestigationValidationError &&
        error.message ===
          "A resolution summary can only be set on a resolved investigation"
    );
  });

  it("refuses to clear the summary of a resolved investigation", () => {
    assert.throws(
      () =>
        applyStatusChange({
          current: state({
            status: "resolved",
            resolvedAt: NOW,
            resolutionSummary: "Restarted the gateway client.",
          }),
          request: { resolutionSummary: null },
          now: NOW,
        }),
      InvestigationValidationError
    );
  });
});

describe("validateListInvestigationsQuery", () => {
  it("defaults to the first page", () => {
    assert.deepEqual(validateListInvestigationsQuery({}), {
      limit: 20,
      offset: 0,
    });
    assert.deepEqual(validateListInvestigationsQuery(undefined), {
      limit: 20,
      offset: 0,
    });
  });

  it("parses filters, paging and a search term", () => {
    const parsed = validateListInvestigationsQuery({
      status: "investigating",
      severity: "high",
      service: " api ",
      q: "  500 errors ",
      limit: "10",
      offset: "20",
    });

    assert.equal(parsed.status, "investigating");
    assert.equal(parsed.severity, "high");
    assert.equal(parsed.service, "api");
    assert.equal(parsed.q, "500 errors");
    assert.equal(parsed.limit, 10);
    assert.equal(parsed.offset, 20);
  });

  it("takes the first value of a repeated query parameter", () => {
    assert.equal(
      validateListInvestigationsQuery({ status: ["open", "closed"] }).status,
      "open"
    );
  });

  it("ignores empty filter values", () => {
    const parsed = validateListInvestigationsQuery({ status: "", limit: "" });

    assert.equal(parsed.status, undefined);
    assert.equal(parsed.limit, 20);
  });

  it("rejects out-of-range or malformed paging", () => {
    for (const query of [
      { limit: "0" },
      { limit: "51" },
      { limit: "2.5" },
      { limit: "ten" },
      { offset: "-1" },
      { offset: "10001" },
    ]) {
      assert.throws(
        () => validateListInvestigationsQuery(query),
        InvestigationValidationError
      );
    }
  });

  it("rejects unknown filters and overlong search terms", () => {
    assert.throws(
      () => validateListInvestigationsQuery({ status: "done" }),
      InvestigationValidationError
    );
    assert.throws(
      () => validateListInvestigationsQuery({ q: "x".repeat(201) }),
      InvestigationValidationError
    );
  });
});

describe("validateNoteBody", () => {
  it("trims a note", () => {
    assert.equal(
      validateNoteBody({ body: "  Checked pg_stat_activity.  " }),
      "Checked pg_stat_activity."
    );
  });

  it("rejects empty, overlong and non-string notes", () => {
    for (const payload of [
      {},
      { body: "   " },
      { body: 42 },
      { body: "x".repeat(4001) },
      null,
    ]) {
      assert.throws(() => validateNoteBody(payload), InvestigationValidationError);
    }
  });
});

describe("normalizeInvestigationId", () => {
  it("accepts a UUID", () => {
    assert.equal(
      normalizeInvestigationId(" 8c1f2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d "),
      "8c1f2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
    );
  });

  it("reports anything else as not found, without explaining the format", () => {
    for (const value of ["", "abc", undefined, 42, null]) {
      assert.throws(
        () => normalizeInvestigationId(value),
        (error: unknown) =>
          error instanceof InvestigationNotFoundError &&
          error.message === "Investigation not found"
      );
    }
  });
});
