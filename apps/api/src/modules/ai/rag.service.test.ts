import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fromRetrievedChunk, selectPromptChunks } from "./rag.service.js";
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

describe("selectPromptChunks", () => {
  it("drops keyword-only evidence when vector or hybrid evidence exists", () => {
    const chunks = [
      citation({ sourceId: "doc-gateway", matchType: "hybrid", similarity: 0.83 }),
      citation({ sourceId: "log-gateway", matchType: "vector", similarity: 0.66 }),
      citation({ sourceId: "doc-rollback", matchType: "keyword", similarity: null }),
      citation({ sourceId: "doc-dns", matchType: "keyword", similarity: null }),
      citation({ sourceId: "doc-restore", matchType: "keyword", similarity: null }),
    ];

    assert.deepEqual(
      selectPromptChunks(chunks).map((chunk) => chunk.sourceId),
      ["doc-gateway", "log-gateway"]
    );
  });

  it("keeps keyword-only evidence when nothing was vector-backed, capped at two", () => {
    const chunks = [
      citation({ sourceId: "k1", matchType: "keyword", similarity: null }),
      citation({ sourceId: "k2", matchType: "keyword", similarity: null }),
      citation({ sourceId: "k3", matchType: "keyword", similarity: null }),
    ];

    assert.deepEqual(
      selectPromptChunks(chunks).map((chunk) => chunk.sourceId),
      ["k1", "k2"]
    );
  });

  it("returns an empty list for empty retrieval", () => {
    assert.deepEqual(selectPromptChunks([]), []);
  });
});

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
