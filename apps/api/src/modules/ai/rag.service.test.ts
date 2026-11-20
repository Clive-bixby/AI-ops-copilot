import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fromRetrievedChunk } from "./rag.service.js";
import type { CitationSource } from "./retrieval.service.js";

function citation(overrides: Partial<CitationSource>): CitationSource {
  return {
    sourceType: "document",
    sourceId: "document-1",
    documentId: "document-1",
    matchType: "vector",
    chunkIndex: 0,
    similarity: 0.9,
    score: 0.016,
    preview: "preview",
    content: "content",
    ...overrides,
  };
}

describe("fromRetrievedChunk", () => {
  it("keeps a keyword-only hit labelled keyword with no similarity", () => {
    const chunk = fromRetrievedChunk(
      citation({
        sourceType: "ticket",
        sourceId: "ticket-1",
        documentId: null,
        matchType: "keyword",
        similarity: null,
      })
    );

    // A citation must not claim a cosine similarity for keyword evidence.
    assert.equal(chunk.matchType, "keyword");
    assert.equal(chunk.similarity, null);
    assert.equal(chunk.documentId, null);
  });

  it("keeps a hybrid hit labelled hybrid with its cosine", () => {
    const chunk = fromRetrievedChunk(
      citation({ matchType: "hybrid", similarity: 0.81 })
    );

    assert.equal(chunk.matchType, "hybrid");
    assert.equal(chunk.similarity, 0.81);
  });

  it("preserves the source identity and content", () => {
    const chunk = fromRetrievedChunk(
      citation({
        sourceType: "log",
        sourceId: "log-1",
        documentId: null,
        chunkIndex: 0,
        content: "connection pool exhausted",
      })
    );

    assert.equal(chunk.sourceType, "log");
    assert.equal(chunk.sourceId, "log-1");
    assert.equal(chunk.content, "connection pool exhausted");
  });
});
