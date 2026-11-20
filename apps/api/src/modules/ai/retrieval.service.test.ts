import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { FullTextResult, SimilarityResult } from "./vector.service.js";
import {
  fuseResults,
  RetrievalValidationError,
  toCitationSource,
  validateRetrievalLimit,
  validateRetrievalMode,
  validateSourceTypes,
} from "./retrieval.service.js";

const RRF_K = 60;

before(() => {
  process.env.HYBRID_RRF_K = String(RRF_K);
});

after(() => {
  delete process.env.HYBRID_RRF_K;
});

function vectorHit(index: number, similarity = 0.9): SimilarityResult {
  return {
    id: `vector-${index}`,
    sourceType: "document",
    sourceId: `document-${index}`,
    documentId: `document-${index}`,
    chunkIndex: 0,
    content: `vector content ${index}`,
    metadata: null,
    distance: 1 - similarity,
    similarity,
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceCreatedAt: null,
  };
}

function keywordHit(index: number, rank = 1): FullTextResult {
  return {
    id: `keyword-${index}`,
    sourceType: "ticket",
    sourceId: `ticket-${index}`,
    documentId: null,
    chunkIndex: 0,
    content: `keyword content ${index}`,
    metadata: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceCreatedAt: null,
    rank,
  };
}

function rrf(rank: number): number {
  return 1 / (RRF_K + rank);
}

function assertClose(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `expected ${expected}, received ${actual}`
  );
}

describe("fuseResults", () => {
  it("ranks a chunk found by both arms above chunks found by one arm", () => {
    const shared = vectorHit(2);
    const fused = fuseResults({
      vectorResults: [vectorHit(1), shared],
      keywordResults: [
        { ...shared, id: "keyword-shared", rank: 1 },
        keywordHit(3),
      ],
      limit: 10,
      mode: "hybrid",
    });

    assert.deepEqual(
      fused.map((candidate) => candidate.sourceId),
      ["document-2", "document-1", "ticket-3"]
    );
    assertClose(fused[0]!.score, rrf(2) + rrf(1));
    assertClose(fused[1]!.score, rrf(1));
    assertClose(fused[2]!.score, rrf(2));
  });

  it("uses each arm's position, not its raw score", () => {
    // A keyword hit with a huge ts_rank cannot outrank a better vector position
    // unless its own rank is better; RRF only sees positions.
    const fused = fuseResults({
      vectorResults: [vectorHit(1, 0.7)],
      keywordResults: [{ ...keywordHit(9), rank: 99 }],
      limit: 10,
      mode: "hybrid",
    });

    assertClose(fused[0]!.score, rrf(1));
    assertClose(fused[1]!.score, rrf(1));
    assert.equal(fused.length, 2);
  });

  it("keeps the vector cosine when the keyword arm contributes the same chunk", () => {
    const shared = vectorHit(4, 0.83);
    const [candidate] = fuseResults({
      vectorResults: [shared],
      keywordResults: [{ ...shared, id: "keyword-shared", rank: 1 }],
      limit: 10,
      mode: "hybrid",
    });

    assert.ok(candidate);
    assert.equal(candidate.similarity, 0.83);
    assert.equal(candidate.vectorRank, 1);
    assert.equal(candidate.keywordRank, 1);
  });

  it("merges the same chunk instead of returning it twice", () => {
    const shared = vectorHit(5);
    const fused = fuseResults({
      vectorResults: [shared, vectorHit(6)],
      keywordResults: [
        { ...shared, id: "keyword-shared", content: "same text, other arm", rank: 1 },
      ],
      limit: 10,
      mode: "hybrid",
    });

    assert.equal(fused.filter((c) => c.sourceId === "document-5").length, 1);
    assert.equal(fused.length, 2);
  });

  it("ignores the keyword arm entirely in vector mode", () => {
    const fused = fuseResults({
      vectorResults: [vectorHit(1, 0.9)],
      keywordResults: [keywordHit(2, 500)],
      limit: 10,
      mode: "vector",
    });

    assert.equal(fused.length, 1);
    assert.equal(fused[0]!.sourceId, "document-1");
    assert.equal(fused[0]!.keywordRank, null);
    assertClose(fused[0]!.score, rrf(1));
  });

  it("applies the limit after fusion, not per arm", () => {
    const fused = fuseResults({
      vectorResults: [vectorHit(1), vectorHit(2), vectorHit(3)],
      keywordResults: [keywordHit(1), keywordHit(2)],
      limit: 2,
      mode: "hybrid",
    });

    assert.equal(fused.length, 2);
  });

  it("collapses duplicate text from different sources to the best-ranked copy", () => {
    const duplicate = "Restart the gateway client to drain stuck connections.";
    const fused = fuseResults({
      vectorResults: [
        { ...vectorHit(1), content: duplicate },
        { ...vectorHit(2), content: `${duplicate} ` },
      ],
      keywordResults: [],
      limit: 10,
      mode: "hybrid",
    });

    assert.equal(fused.length, 1);
    assert.equal(fused[0]!.sourceId, "document-1");
  });
});

describe("toCitationSource", () => {
  it("marks a chunk found by both arms as hybrid", () => {
    const shared = vectorHit(1, 0.75);
    const [candidate] = fuseResults({
      vectorResults: [shared],
      keywordResults: [{ ...shared, id: "keyword-shared", rank: 1 }],
      limit: 10,
      mode: "hybrid",
    });

    const citation = toCitationSource(candidate!);

    assert.equal(citation.matchType, "hybrid");
    assert.equal(citation.similarity, 0.75);
    assert.equal(citation.score, 0.032787);
  });

  it("returns keyword-only hits with a real score and no invented similarity", () => {
    const [fused] = fuseResults({
      vectorResults: [],
      keywordResults: [keywordHit(1, 1)],
      limit: 10,
      mode: "hybrid",
    });

    const citation = toCitationSource(fused!);

    assert.equal(citation.matchType, "keyword");
    assert.equal(citation.similarity, null);
    assert.equal(citation.documentId, null);
    assert.equal(citation.score, 0.016393);
    assert.ok(citation.score > 0);
    assert.ok(citation.preview.length > 0);
  });

  it("marks a vector-only hit as vector and keeps its cosine", () => {
    const [fused] = fuseResults({
      vectorResults: [vectorHit(1, 0.91)],
      keywordResults: [keywordHit(1, 1)],
      limit: 10,
      mode: "vector",
    });

    const citation = toCitationSource(fused!);

    assert.equal(citation.matchType, "vector");
    assert.equal(citation.similarity, 0.91);
  });
});

describe("validateRetrievalMode", () => {
  it("defaults to hybrid", () => {
    assert.equal(validateRetrievalMode(undefined), "hybrid");
  });

  it("accepts the supported modes", () => {
    assert.equal(validateRetrievalMode("hybrid"), "hybrid");
    assert.equal(validateRetrievalMode("vector"), "vector");
  });

  it("rejects unknown modes instead of silently falling back", () => {
    for (const value of ["keyword", "HYBRID", "", 1, null, {}]) {
      assert.throws(
        () => validateRetrievalMode(value),
        (error: unknown) =>
          error instanceof RetrievalValidationError &&
          error.message === "mode must be 'hybrid' or 'vector'"
      );
    }
  });
});

describe("validateSourceTypes", () => {
  it("leaves the filter unset when the field is absent", () => {
    assert.equal(validateSourceTypes(undefined), undefined);
  });

  it("deduplicates source types while preserving order", () => {
    assert.deepEqual(validateSourceTypes(["log", "document", "log"]), [
      "log",
      "document",
    ]);
  });

  it("keeps an explicit empty list as an empty list", () => {
    assert.deepEqual(validateSourceTypes([]), []);
  });

  it("rejects non-arrays and unsupported source types", () => {
    assert.throws(() => validateSourceTypes("document"), RetrievalValidationError);
    assert.throws(
      () => validateSourceTypes(["document", "invoice"]),
      (error: unknown) =>
        error instanceof RetrievalValidationError &&
        error.message === "Unsupported source type 'invoice'"
    );
    assert.throws(() => validateSourceTypes([1]), RetrievalValidationError);
  });
});

describe("validateRetrievalLimit", () => {
  it("defaults to five", () => {
    assert.equal(validateRetrievalLimit(undefined), 5);
  });

  it("accepts integers in the public range", () => {
    assert.equal(validateRetrievalLimit(1), 1);
    assert.equal(validateRetrievalLimit(10), 10);
  });

  it("rejects out-of-range and non-integer limits", () => {
    for (const value of [0, 11, 2.5, "5", Number.NaN, null]) {
      assert.throws(() => validateRetrievalLimit(value), RetrievalValidationError);
    }
  });
});
