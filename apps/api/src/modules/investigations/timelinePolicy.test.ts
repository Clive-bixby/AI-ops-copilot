import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTimeline } from "./timelinePolicy.js";
import type {
  Investigation,
  InvestigationActivity,
  InvestigationEvidenceItem,
} from "./types.js";

/**
 * The timeline is a pure projection of activity and evidence, so every rule that
 * decides what an engineer sees — order, window labels, correlations — is
 * pinned here without a database.
 */

const INVESTIGATION: Investigation = {
  id: "11111111-1111-1111-1111-111111111111",
  organizationId: "22222222-2222-2222-2222-222222222222",
  title: "API intermittently returns HTTP 500",
  description: "Checkout requests return 500 when the connection pool is exhausted.",
  status: "investigating",
  severity: "high",
  service: "api",
  errorSignature: "connection pool exhausted",
  windowStart: "2026-11-21T09:00:00.000Z",
  windowEnd: "2026-11-21T10:00:00.000Z",
  sourceTypes: null,
  resolutionSummary: null,
  ownerUserId: null,
  ownerEmail: null,
  createdBy: "33333333-3333-3333-3333-333333333333",
  createdByEmail: "engineer@example.com",
  resolvedAt: null,
  closedAt: null,
  createdAt: "2026-11-21T08:00:00.000Z",
  updatedAt: "2026-11-21T08:00:00.000Z",
};

function activityEntry(
  id: string,
  type: InvestigationActivity["type"],
  createdAt: string,
  body: string | null = null
): InvestigationActivity {
  return {
    id,
    type,
    actorUserId: null,
    actorEmail: "engineer@example.com",
    body,
    metadata: null,
    createdAt,
  };
}

function evidenceItem(
  overrides: Partial<InvestigationEvidenceItem> = {}
): InvestigationEvidenceItem {
  return {
    id: "evidence-1",
    investigationId: INVESTIGATION.id,
    sourceType: "document",
    sourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    chunkIndex: 0,
    sourceTitle: "runbook.md",
    excerpt: "restart the worker",
    sourceCreatedAt: "2026-11-21T09:20:00.000Z",
    sourceMetadata: null,
    matchType: "hybrid",
    retrievalScore: 0.5,
    similarity: 0.75,
    relevance: "related",
    inclusionReason: "Retrieved with cosine similarity 0.75.",
    retrievalQuery: "checkout 500",
    origin: "retrieval",
    addedBy: null,
    createdAt: "2026-11-21T09:25:00.000Z",
    ...overrides,
  };
}

function correlationsOf(
  timeline: ReturnType<typeof buildTimeline>,
  eventId: string
): string[] {
  const event = timeline.events.find((entry) => entry.id === eventId);
  assert.ok(event, `expected an event ${eventId}`);
  return event.correlations;
}

describe("buildTimeline", () => {
  it("orders events chronologically and puts an action before the source event at the same instant", () => {
    const timeline = buildTimeline({
      investigation: INVESTIGATION,
      activity: [
        activityEntry("a1", "created", "2026-11-21T08:00:00.000Z", "Investigation created"),
        activityEntry("a2", "note", "2026-11-21T09:15:00.000Z", "Checked the pool metrics"),
      ],
      evidence: [
        evidenceItem({
          id: "e1",
          sourceType: "log",
          sourceTitle: "connection pool exhausted",
          sourceCreatedAt: "2026-11-21T09:15:00.000Z",
          excerpt: "connection pool exhausted: too many clients already",
        }),
        evidenceItem({
          id: "e2",
          sourceTitle: "runbook.md",
          sourceCreatedAt: "2026-11-21T08:30:00.000Z",
        }),
      ],
      now: "2026-11-21T12:00:00.000Z",
    });

    assert.deepEqual(
      timeline.events.map((event) => event.id),
      ["activity:a1", "evidence:e2", "activity:a2", "evidence:e1"]
    );
    assert.equal(timeline.summary.total, 4);
  });

  it("labels evidence inside and outside the investigation window", () => {
    const timeline = buildTimeline({
      investigation: INVESTIGATION,
      activity: [],
      evidence: [
        evidenceItem({ id: "before", sourceCreatedAt: "2026-11-21T08:30:00.000Z" }),
        evidenceItem({ id: "inside", sourceCreatedAt: "2026-11-21T09:20:00.000Z" }),
        evidenceItem({ id: "after", sourceCreatedAt: "2026-11-21T10:30:00.000Z" }),
      ],
      now: "2026-11-21T12:00:00.000Z",
    });

    assert.deepEqual(correlationsOf(timeline, "evidence:before"), ["before_window"]);
    assert.deepEqual(correlationsOf(timeline, "evidence:inside"), ["in_window"]);
    assert.deepEqual(correlationsOf(timeline, "evidence:after"), ["after_window"]);
  });

  it("marks signature matches and same-service evidence", () => {
    const timeline = buildTimeline({
      investigation: INVESTIGATION,
      activity: [],
      evidence: [
        evidenceItem({
          id: "log",
          sourceType: "log",
          sourceTitle: "API errors",
          excerpt: "connection pool exhausted: too many clients already",
          sourceMetadata: { kind: "log", service: "api" },
          sourceCreatedAt: "2026-11-21T09:10:00.000Z",
        }),
        evidenceItem({
          id: "doc",
          sourceTitle: "billing-runbook.md",
          excerpt: "invoice retries",
          sourceMetadata: { kind: "document" },
          sourceCreatedAt: "2026-11-21T09:12:00.000Z",
        }),
      ],
      now: "2026-11-21T12:00:00.000Z",
    });

    assert.deepEqual(correlationsOf(timeline, "evidence:log"), [
      "signature_match",
      "same_service",
      "in_window",
      "time_cluster",
    ]);
    assert.deepEqual(correlationsOf(timeline, "evidence:doc"), [
      "in_window",
      "time_cluster",
    ]);
  });

  it("clusters only evidence whose timestamps are close together", () => {
    const timeline = buildTimeline({
      investigation: INVESTIGATION,
      activity: [],
      evidence: [
        evidenceItem({ id: "first", sourceCreatedAt: "2026-11-21T09:15:00.000Z" }),
        evidenceItem({ id: "second", sourceCreatedAt: "2026-11-21T09:40:00.000Z" }),
        evidenceItem({ id: "late", sourceCreatedAt: "2026-11-21T11:00:00.000Z" }),
      ],
      now: "2026-11-21T12:00:00.000Z",
    });

    assert.ok(correlationsOf(timeline, "evidence:first").includes("time_cluster"));
    assert.ok(correlationsOf(timeline, "evidence:second").includes("time_cluster"));
    assert.equal(
      correlationsOf(timeline, "evidence:late").includes("time_cluster"),
      false
    );
    assert.equal(timeline.summary.correlations.time_cluster, 2);
  });

  it("falls back to the recorded time when a source has no timestamp", () => {
    const timeline = buildTimeline({
      investigation: INVESTIGATION,
      activity: [],
      evidence: [
        evidenceItem({
          id: "undated",
          sourceCreatedAt: null,
          createdAt: "2026-11-21T09:05:00.000Z",
        }),
      ],
      now: "2026-11-21T12:00:00.000Z",
    });

    const event = timeline.events[0];
    assert.equal(event?.at, "2026-11-21T09:05:00.000Z");
    assert.equal(event?.atSourceTime, false);
    assert.deepEqual(event?.correlations, []);
    assert.equal(timeline.summary.undated, 1);
  });

  it("keeps the newest events when the cap is reached and reports the clipping", () => {
    const timeline = buildTimeline({
      investigation: INVESTIGATION,
      activity: [],
      evidence: [
        evidenceItem({ id: "one", sourceCreatedAt: "2026-11-21T09:01:00.000Z" }),
        evidenceItem({ id: "two", sourceCreatedAt: "2026-11-21T09:02:00.000Z" }),
        evidenceItem({ id: "three", sourceCreatedAt: "2026-11-21T09:03:00.000Z" }),
      ],
      now: "2026-11-21T12:00:00.000Z",
      maxEvents: 2,
    });

    assert.equal(timeline.summary.clipped, true);
    assert.equal(timeline.summary.total, 2);
    assert.deepEqual(
      timeline.events.map((event) => event.id),
      ["evidence:two", "evidence:three"]
    );
  });

  it("summarises evidence by source type and correlation counts", () => {
    const timeline = buildTimeline({
      investigation: INVESTIGATION,
      activity: [activityEntry("a1", "created", "2026-11-21T08:00:00.000Z")],
      evidence: [
        evidenceItem({ id: "doc", sourceType: "document" }),
        evidenceItem({ id: "log", sourceType: "log", sourceCreatedAt: "2026-11-21T09:19:00.000Z" }),
        evidenceItem({ id: "ticket", sourceType: "ticket", sourceCreatedAt: "2026-11-21T09:18:00.000Z" }),
      ],
      now: "2026-11-21T12:00:00.000Z",
    });

    assert.deepEqual(timeline.summary.bySourceType, {
      document: 1,
      log: 1,
      ticket: 1,
    });
    assert.equal(timeline.summary.evidence, 3);
    assert.equal(timeline.summary.activity, 1);
    assert.equal(timeline.summary.clipped, false);
    assert.equal(timeline.summary.correlations.in_window, 3);
    assert.equal(timeline.summary.correlations.signature_match, 0);
    assert.equal(timeline.summary.correlations.time_cluster, 3);
  });
});
