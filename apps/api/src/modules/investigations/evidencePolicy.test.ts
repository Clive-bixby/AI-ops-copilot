import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InvestigationNotFoundError,
  InvestigationValidationError,
} from "./errors.js";
import {
  buildEvidenceQueries,
  buildExcerpt,
  dedupeCandidates,
  EVIDENCE_LIMITS,
  gradeEvidence,
  normalizeEvidenceId,
  selectEvidence,
  sourceKey,
  textMatchesSignature,
  validateManualEvidenceInput,
} from "./evidencePolicy.js";
import type {
  ResolvedEvidenceSource,
  RetrievalEvidenceCandidate,
} from "./evidencePolicy.js";

function candidate(
  overrides: Partial<RetrievalEvidenceCandidate> = {}
): RetrievalEvidenceCandidate {
  return {
    sourceType: "document",
    sourceId: "doc-1",
    chunkIndex: 0,
    content: "content",
    sourceCreatedAt: null,
    matchType: "vector",
    score: 0.03,
    similarity: 0.9,
    retrievalQuery: "query",
    ...overrides,
  };
}

function source(
  overrides: Partial<ResolvedEvidenceSource> = {}
): ResolvedEvidenceSource {
  return {
    sourceType: "document",
    sourceId: "doc-1",
    sourceTitle: "postgres-connection-pool-runbook.md",
    excerpt: "excerpt",
    sourceCreatedAt: null,
    service: null,
    status: null,
    metadata: null,
    ...overrides,
  };
}

function sourceMap(items: ResolvedEvidenceSource[]) {
  return new Map(
    items.map((item) => [sourceKey(item.sourceType, item.sourceId), item])
  );
}

const NO_INVESTIGATION = { service: null, errorSignature: null };

describe("buildEvidenceQueries", () => {
  it("always searches the problem statement first", () => {
    const plans = buildEvidenceQueries({
      description: "API requests intermittently return HTTP 500.",
      errorSignature: null,
      service: null,
    });

    assert.deepEqual(plans, [
      {
        query: "API requests intermittently return HTTP 500.",
        label: "description",
      },
    ]);
  });

  it("adds the error signature and a service query", () => {
    const plans = buildEvidenceQueries({
      description: "Checkout requests are failing.",
      errorSignature: "connection pool exhausted",
      service: "checkout",
    });

    assert.deepEqual(
      plans.map((plan) => plan.label),
      ["description", "error_signature", "service"]
    );
    assert.equal(plans[2]?.query, "checkout error failure timeout");
  });

  it("deduplicates identical queries, ignoring case", () => {
    const plans = buildEvidenceQueries({
      description: "Connection pool exhausted",
      errorSignature: "connection pool exhausted",
      service: null,
    });

    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.label, "description");
  });

  it("skips blank advice fields and too-short descriptions", () => {
    assert.deepEqual(
      buildEvidenceQueries({
        description: "ab",
        errorSignature: "   ",
        service: "  ",
      }),
      []
    );
  });

  it("caps query length and the number of queries", () => {
    const plans = buildEvidenceQueries({
      description: "x".repeat(900),
      errorSignature: "y".repeat(900),
      service: "z".repeat(200),
    });

    assert.equal(plans.length, 3);
    for (const plan of plans) {
      assert.ok(plan.query.length <= EVIDENCE_LIMITS.maxQueryChars);
    }
  });
});

describe("textMatchesSignature", () => {
  it("matches a full signature inside a noisy excerpt", () => {
    assert.equal(
      textMatchesSignature(
        "ERROR connection pool exhausted: too many clients already (host db-1)",
        "connection pool exhausted: too many clients already"
      ),
      true
    );
  });

  it("matches an identifier signature", () => {
    assert.equal(
      textMatchesSignature("settlement rejected with XJ-4471", "XJ-4471"),
      true
    );
  });

  it("does not match on a single shared word", () => {
    assert.equal(
      textMatchesSignature(
        "kafka broker upgraded to 3.6",
        "kafka consumer lag on partition checkout-3"
      ),
      false
    );
  });

  it("never matches without a signature or without text", () => {
    assert.equal(textMatchesSignature("anything", null), false);
    assert.equal(textMatchesSignature("", "connection pool exhausted"), false);
  });
});

describe("gradeEvidence", () => {
  it("grades a resolved ticket as historical evidence", () => {
    const grading = gradeEvidence({
      candidate: candidate({ sourceType: "ticket", similarity: null, matchType: "keyword" }),
      source: source({
        sourceType: "ticket",
        sourceId: "doc-1",
        sourceTitle: "Pool exhaustion after release",
        status: "resolved",
      }),
      investigation: NO_INVESTIGATION,
    });

    assert.equal(grading.relevance, "historical");
    assert.match(grading.inclusionReason, /already 'resolved'/);
  });

  it("grades a signature match as direct evidence", () => {
    const grading = gradeEvidence({
      candidate: candidate({
        sourceType: "log",
        content: "ERROR connection pool exhausted: too many clients already",
        similarity: 0.4,
      }),
      source: source({
        sourceType: "log",
        sourceTitle: "connection pool exhausted",
        service: "api",
      }),
      investigation: {
        service: null,
        errorSignature: "connection pool exhausted",
      },
    });

    assert.equal(grading.relevance, "direct");
    assert.equal(
      grading.inclusionReason,
      "Excerpt matches the investigation's error signature."
    );
  });

  it("grades high similarity as direct and mid similarity as related", () => {
    const direct = gradeEvidence({
      candidate: candidate({ similarity: 0.86 }),
      source: source(),
      investigation: NO_INVESTIGATION,
    });
    assert.equal(direct.relevance, "direct");
    assert.match(direct.inclusionReason, /0\.86/);

    const related = gradeEvidence({
      candidate: candidate({ similarity: 0.72 }),
      source: source(),
      investigation: NO_INVESTIGATION,
    });
    assert.equal(related.relevance, "related");
    assert.match(related.inclusionReason, /0\.72/);
  });

  it("grades a matching service as related context", () => {
    const grading = gradeEvidence({
      candidate: candidate({
        sourceType: "log",
        similarity: 0.3,
        matchType: "keyword",
      }),
      source: source({
        sourceType: "log",
        service: "checkout",
      }),
      investigation: { service: "Checkout", errorSignature: null },
    });

    assert.equal(grading.relevance, "related");
    assert.match(grading.inclusionReason, /service 'checkout'/i);
  });

  it("grades keyword-only matches as weak, with no invented similarity", () => {
    const grading = gradeEvidence({
      candidate: candidate({ matchType: "keyword", similarity: null }),
      source: source(),
      investigation: NO_INVESTIGATION,
    });

    assert.equal(grading.relevance, "weak");
    assert.match(grading.inclusionReason, /keywords only/);
  });

  it("grades a manual link without a signal as weak", () => {
    const grading = gradeEvidence({
      candidate: candidate({ matchType: "manual", similarity: null }),
      source: source(),
      investigation: NO_INVESTIGATION,
    });

    assert.equal(grading.relevance, "weak");
    assert.match(grading.inclusionReason, /manually/);
  });

  it("grades a low-similarity vector hit as weak context", () => {
    const grading = gradeEvidence({
      candidate: candidate({ similarity: 0.4 }),
      source: source(),
      investigation: NO_INVESTIGATION,
    });

    assert.equal(grading.relevance, "weak");
    assert.match(grading.inclusionReason, /below the direct and related/);
  });
});

describe("dedupeCandidates", () => {
  it("keeps one candidate per source, preferring the higher score", () => {
    const deduped = dedupeCandidates([
      candidate({ chunkIndex: 0, score: 0.01 }),
      candidate({ chunkIndex: 3, score: 0.02 }),
      candidate({ sourceId: "doc-2", score: 0.005 }),
    ]);

    assert.equal(deduped.length, 2);
    assert.equal(deduped[0]?.chunkIndex, 3);
  });

  it("breaks a score tie with similarity", () => {
    const deduped = dedupeCandidates([
      candidate({ chunkIndex: 0, score: 0.02, similarity: 0.7 }),
      candidate({ chunkIndex: 1, score: 0.02, similarity: 0.9 }),
    ]);

    assert.equal(deduped[0]?.chunkIndex, 1);
  });
});

describe("selectEvidence", () => {
  it("orders direct evidence before related before weak", () => {
    const strong = candidate({ sourceId: "weak-1", score: 0.09, similarity: 0.3 });
    const related = candidate({ sourceId: "related-1", score: 0.05, similarity: 0.72 });
    const direct = candidate({ sourceId: "direct-1", score: 0.01, similarity: 0.95 });

    const { selected } = selectEvidence({
      candidates: [strong, related, direct],
      sources: sourceMap([
        source({ sourceId: "weak-1" }),
        source({ sourceId: "related-1" }),
        source({ sourceId: "direct-1" }),
      ]),
      investigation: NO_INVESTIGATION,
    });

    assert.deepEqual(
      selected.map((item) => item.candidate.sourceId),
      ["direct-1", "related-1", "weak-1"]
    );
  });

  it("caps each source type and the total budget", () => {
    const candidates = [
      ...Array.from({ length: 5 }, (_, index) =>
        candidate({ sourceType: "document", sourceId: `doc-${index}` })
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        candidate({ sourceType: "log", sourceId: `log-${index}` })
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        candidate({ sourceType: "ticket", sourceId: `ticket-${index}` })
      ),
    ];

    const sources = sourceMap(
      candidates.map((item) =>
        source({
          sourceType: item.sourceType,
          sourceId: item.sourceId,
        })
      )
    );

    const { selected } = selectEvidence({
      candidates,
      sources,
      investigation: NO_INVESTIGATION,
    });

    assert.equal(selected.length, EVIDENCE_LIMITS.maxItems);
    const byType = selected.reduce<Record<string, number>>((acc, item) => {
      acc[item.candidate.sourceType] = (acc[item.candidate.sourceType] ?? 0) + 1;
      return acc;
    }, {});

    assert.deepEqual(byType, { document: 4, log: 4, ticket: 4 });
  });

  it("honours an explicit budget", () => {
    const { selected } = selectEvidence({
      candidates: [
        candidate({ sourceId: "a" }),
        candidate({ sourceId: "b" }),
        candidate({ sourceId: "c" }),
      ],
      sources: sourceMap([
        source({ sourceId: "a" }),
        source({ sourceId: "b" }),
        source({ sourceId: "c" }),
      ]),
      investigation: NO_INVESTIGATION,
      maxItems: 2,
    });

    assert.equal(selected.length, 2);
  });

  it("counts candidates whose source no longer exists instead of storing them", () => {
    const { selected, unresolved } = selectEvidence({
      candidates: [
        candidate({ sourceId: "exists" }),
        candidate({ sourceId: "deleted" }),
      ],
      sources: sourceMap([source({ sourceId: "exists" })]),
      investigation: NO_INVESTIGATION,
    });

    assert.equal(selected.length, 1);
    assert.equal(unresolved, 1);
  });

  it("does not return the same source twice", () => {
    const { selected } = selectEvidence({
      candidates: [
        candidate({ chunkIndex: 0 }),
        candidate({ chunkIndex: 1 }),
      ],
      sources: sourceMap([source()]),
      investigation: NO_INVESTIGATION,
    });

    assert.equal(selected.length, 1);
  });
});

describe("buildExcerpt", () => {
  it("keeps line breaks and trims trailing whitespace", () => {
    assert.equal(
      buildExcerpt("Line one   \nLine two\t\n"),
      "Line one\nLine two"
    );
  });

  it("caps the excerpt and marks the truncation", () => {
    const excerpt = buildExcerpt("word ".repeat(1000));

    assert.equal(excerpt.length, EVIDENCE_LIMITS.excerptChars);
    assert.ok(excerpt.endsWith("…"));
  });

  it("never stores an empty excerpt", () => {
    assert.equal(buildExcerpt("   \n  "), "(no content)");
  });
});

describe("validateManualEvidenceInput", () => {
  it("accepts a source reference with an optional reason", () => {
    const parsed = validateManualEvidenceInput({
      sourceType: "ticket",
      sourceId: "8c1f2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      reason: "  Previous resolution for the same error  ",
    });

    assert.equal(parsed.sourceType, "ticket");
    assert.equal(parsed.reason, "Previous resolution for the same error");
  });

  it("treats an empty reason as absent", () => {
    assert.equal(
      validateManualEvidenceInput({
        sourceType: "log",
        sourceId: "8c1f2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        reason: "   ",
      }).reason,
      null
    );
  });

  it("rejects unsupported source types and malformed ids", () => {
    assert.throws(
      () =>
        validateManualEvidenceInput({
          sourceType: "invoice",
          sourceId: "8c1f2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        }),
      InvestigationValidationError
    );
    assert.throws(
      () => validateManualEvidenceInput({ sourceType: "document", sourceId: "doc-1" }),
      InvestigationValidationError
    );
  });

  it("rejects an overlong reason and a non-object body", () => {
    assert.throws(
      () =>
        validateManualEvidenceInput({
          sourceType: "document",
          sourceId: "8c1f2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
          reason: "x".repeat(EVIDENCE_LIMITS.manualReasonMax + 1),
        }),
      InvestigationValidationError
    );
    assert.throws(() => validateManualEvidenceInput(null), InvestigationValidationError);
  });
});

describe("normalizeEvidenceId", () => {
  it("accepts a UUID and reports anything else as not found", () => {
    assert.equal(
      normalizeEvidenceId("8c1f2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"),
      "8c1f2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
    );

    assert.throws(
      () => normalizeEvidenceId("nope"),
      (error: unknown) =>
        error instanceof InvestigationNotFoundError &&
        error.message === "Evidence not found"
    );
  });
});
