import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fuseResults,
  RetrievalValidationError,
  toCitationSource,
  validateTimeRange,
} from "./retrieval.service.js";
import type { FullTextResult, SimilarityResult } from "./vector.service.js";

function vectorHit(
  overrides: Partial<SimilarityResult> = {}
): SimilarityResult {
  return {
    id: "chunk-1",
    sourceType: "document",
    sourceId: "doc-1",
    documentId: "doc-1",
    chunkIndex: 0,
    content: "connection pool exhausted",
    metadata: null,
    distance: 0.1,
    similarity: 0.9,
    createdAt: "2026-11-21T10:00:00.000Z",
    sourceCreatedAt: "2026-11-21T09:00:00.000Z",
    ...overrides,
  };
}

function keywordHit(
  overrides: Partial<FullTextResult> = {}
): FullTextResult {
  return {
    id: "chunk-1",
    sourceType: "document",
    sourceId: "doc-1",
    documentId: "doc-1",
    chunkIndex: 0,
    content: "connection pool exhausted",
    metadata: null,
    createdAt: "2026-11-21T10:00:00.000Z",
    sourceCreatedAt: "2026-11-21T09:00:00.000Z",
    rank: 0.5,
    matchedLexemes: 2,
    ...overrides,
  };
}

describe("validateTimeRange", () => {
  it("treats an absent or empty range as no filter", () => {
    assert.equal(validateTimeRange(undefined), undefined);
    assert.equal(validateTimeRange(null), undefined);
    assert.equal(validateTimeRange({}), undefined);
    assert.equal(validateTimeRange({ start: "", end: null }), undefined);
  });

  it("normalises bounds to ISO and allows an open-ended range", () => {
    assert.deepEqual(validateTimeRange({ start: "2026-11-21T09:00:00+02:00" }), {
      start: "2026-11-21T07:00:00.000Z",
    });
    assert.deepEqual(validateTimeRange({ end: "2026-11-21T10:00:00Z" }), {
      end: "2026-11-21T10:00:00.000Z",
    });
  });

  it("rejects a backwards range and unparseable bounds", () => {
    assert.throws(
      () =>
        validateTimeRange({
          start: "2026-11-21T10:00:00Z",
          end: "2026-11-21T09:00:00Z",
        }),
      (error: unknown) =>
        error instanceof RetrievalValidationError &&
        error.message === "timeRange.end must be after timeRange.start"
    );

    assert.throws(
      () => validateTimeRange({ start: "yesterday" }),
      RetrievalValidationError
    );
    assert.throws(
      () => validateTimeRange({ start: 42 }),
      RetrievalValidationError
    );
  });

  it("rejects a non-object range", () => {
    assert.throws(() => validateTimeRange("2026-11-21"), RetrievalValidationError);
    assert.throws(() => validateTimeRange([1, 2]), RetrievalValidationError);
  });
});

describe("source timestamps through fusion", () => {
  it("keeps the source timestamp on a fused citation", () => {
    const [fused] = fuseResults({
      vectorResults: [vectorHit()],
      keywordResults: [],
      limit: 10,
      mode: "hybrid",
    });

    const citation = toCitationSource(fused!);

    assert.equal(citation.sourceCreatedAt, "2026-11-21T09:00:00.000Z");
    assert.equal(citation.matchType, "vector");
  });

  it("keeps a timestamp contributed by either arm", () => {
    const [fused] = fuseResults({
      vectorResults: [vectorHit({ sourceCreatedAt: null })],
      keywordResults: [keywordHit()],
      limit: 10,
      mode: "hybrid",
    });

    const citation = toCitationSource(fused!);

    assert.equal(citation.matchType, "hybrid");
    assert.equal(citation.sourceCreatedAt, "2026-11-21T09:00:00.000Z");
  });

  it("reports a genuinely missing timestamp as null, not as the collection time", () => {
    const [fused] = fuseResults({
      vectorResults: [vectorHit({ sourceCreatedAt: null })],
      keywordResults: [],
      limit: 10,
      mode: "hybrid",
    });

    assert.equal(toCitationSource(fused!).sourceCreatedAt, null);
  });
});
