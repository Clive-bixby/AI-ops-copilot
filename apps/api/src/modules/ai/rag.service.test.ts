import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RAGProviderError,
  RAGProviderTimeoutError,
  fromRetrievedChunk,
  mapAnswerProviderError,
  selectPromptChunks,
} from "./rag.service.js";
import { LlmConfigError, LlmProviderError, LlmTimeoutError } from "./llm/errors.js";
import type { CitationSource } from "./retrieval.service.js";

function citation(overrides: Partial<CitationSource>): CitationSource {
  return {
    sourceType: "document",
    sourceId: "document-1",
    documentId: "document-1",
    matchType: "vector",
    chunkIndex: 0,
    sourceCreatedAt: null,
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

describe("mapAnswerProviderError", () => {
  // A missing key is a deployment misconfiguration, not a crash: /ai/ask has
  // always answered 502 with the variable named, and a generic 500 would hide
  // the one sentence that fixes it.
  it("turns a missing key into the provider error, not a 500", () => {
    const mapped = mapAnswerProviderError(
      new LlmConfigError("GEMINI_API_KEY is required to generate an answer")
    );

    assert.ok(mapped instanceof RAGProviderError);
    assert.ok(!(mapped instanceof RAGProviderTimeoutError));
    assert.match(mapped.message, /GEMINI_API_KEY/);
  });

  it("keeps a slow provider mapped to the timeout error", () => {
    assert.ok(
      mapAnswerProviderError(new LlmTimeoutError("no answer in time")) instanceof
        RAGProviderTimeoutError
    );
  });

  it("maps a provider failure onto the provider error with its message", () => {
    const mapped = mapAnswerProviderError(
      new LlmProviderError("The generation provider is rate limiting this deployment (429).", 429)
    );

    assert.ok(mapped instanceof RAGProviderError);
    assert.match(mapped.message, /rate limiting/);
  });

  it("passes an unrelated error through unchanged", () => {
    const original = new Error("database went away");

    assert.equal(mapAnswerProviderError(original), original);
  });
});
