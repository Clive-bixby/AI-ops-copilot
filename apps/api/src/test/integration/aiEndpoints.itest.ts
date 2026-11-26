import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { resetEmbeddingProvider } from "../../modules/ai/embedding/index.js";
import { resetLlmProvider } from "../../modules/ai/llm/index.js";
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

/**
 * The AI domain over HTTP, with both providers scripted.
 *
 * `/ai/search` and `/ai/ask` embed with the configured provider and `/ai/ask`
 * then generates with the configured model, so the suite points both at local
 * servers: the request the application sends and the retrieval it performs are
 * the real ones, while no live provider is called and no quota is spent. Each
 * case asserts what the caller receives -- which sources came back, and the
 * exact no-context sentence -- instead of a bare status.
 */

type Stub = { url: string; calls: number; close: () => void };

const NO_CONTEXT_ANSWER = "No reliable operational context found.";

function unitVector(dimensions = 768): number[] {
  return Array.from({ length: dimensions }, (_, index) => (index === 0 ? 1 : 0));
}

function unitVectorLiteral(dimensions: number): string {
  const values = new Array<string>(dimensions).fill("0");
  values[0] = "1";

  return `[${values.join(",")}]`;
}

async function startEmbeddingStub(): Promise<Stub> {
  const state = { calls: 0 };

  const server = http.createServer((request, response) => {
    let raw = "";

    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });

    request.on("end", () => {
      // `/ai/health` probes the model list, never the embedding endpoint.
      if (request.method === "GET") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "test-embed" }] }));
        return;
      }

      state.calls += 1;

      let texts: string[] = [];
      try {
        const input = (JSON.parse(raw) as { input?: unknown }).input;
        texts = Array.isArray(input) ? input.map(String) : [String(input ?? "")];
      } catch {
        texts = [];
      }

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          model: "test-embed",
          data: texts.map((_text, index) => ({ index, embedding: unitVector() })),
        })
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    get url() {
      return `http://127.0.0.1:${address.port}`;
    },
    get calls() {
      return state.calls;
    },
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

async function startLlmStub(answer: string): Promise<Stub> {
  const state = { calls: 0 };

  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      state.calls += 1;

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: answer }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 40 },
        })
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    get url() {
      return `http://127.0.0.1:${address.port}`;
    },
    get calls() {
      return state.calls;
    },
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

let embedding: Stub;
let llm: Stub;
let server: TestServer;
let orgA: string;
let orgB: string;
let ownerA: string;
let ownerB: string;

function auth(userId: string, organizationId: string) {
  return { token: tokenFor(userId), organizationId };
}

async function insertDocumentWithChunk(input: {
  organizationId: string;
  filename: string;
  content: string;
}): Promise<string> {
  const document = await getPool().query<{ id: string }>(
    // `documents_processed_at_check` ties 'processed' to a non-null timestamp.
    `INSERT INTO documents (organization_id, filename, content, processing_status, processed_at)
     VALUES ($1, $2, $3, 'processed', NOW())
     RETURNING id`,
    [input.organizationId, input.filename, input.content]
  );

  const documentId = document.rows[0]!.id;
  const { getEmbeddingConfig } = await import(
    "../../modules/ingestion/embeddingConfig.js"
  );
  const config = getEmbeddingConfig();

  await getPool().query(
    `INSERT INTO source_chunks (
       organization_id, source_type, source_id, chunk_index, content, embedding,
       embedding_model, embedding_dimensions, chunk_hash, source_created_at, metadata
     )
     VALUES ($1, 'document', $2, 0, $3, $4::vector, $5, $6, $7, NOW(), '{}'::jsonb)`,
    [
      input.organizationId,
      documentId,
      input.content,
      unitVectorLiteral(config.dimensions),
      config.model,
      config.dimensions,
      createHash("md5").update(input.content).digest("hex"),
    ]
  );

  return documentId;
}

before(async () => {
  await setupTestDatabase();

  embedding = await startEmbeddingStub();
  llm = await startLlmStub(
    "The connection pool is exhausted by long-lived checkout transactions."
  );

  process.env.EMBEDDING_PROVIDER = "openai-compatible";
  process.env.EMBEDDING_BASE_URL = embedding.url;
  process.env.EMBEDDING_MODEL = "test-embed";
  process.env.EMBEDDING_DIMENSIONS = "768";
  process.env.EMBEDDING_API_KEY = "test-key";

  process.env.LLM_PROVIDER = "gemini";
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_BASE_URL = llm.url;
  process.env.LLM_TIMEOUT_MS = "1000";
  process.env.LLM_MAX_RETRIES = "0";

  resetEmbeddingProvider();
  resetLlmProvider();

  server = await startServer();
});

after(async () => {
  await server?.close();
  embedding?.close();
  llm?.close();

  for (const name of [
    "EMBEDDING_PROVIDER",
    "EMBEDDING_BASE_URL",
    "EMBEDDING_MODEL",
    "EMBEDDING_DIMENSIONS",
    "EMBEDDING_API_KEY",
    "LLM_PROVIDER",
    "LLM_API_KEY",
    "LLM_BASE_URL",
    "LLM_TIMEOUT_MS",
    "LLM_MAX_RETRIES",
  ]) {
    delete process.env[name];
  }

  resetEmbeddingProvider();
  resetLlmProvider();

  if (hasPool()) {
    await getPool().end();
  }
});

beforeEach(async () => {
  await resetDatabase();

  orgA = await createOrganization("AI Org A");
  orgB = await createOrganization("AI Org B");

  ownerA = await createUser("owner@ai-a.example.test");
  ownerB = await createUser("owner@ai-b.example.test");

  await addMembership(ownerA, orgA, "owner");
  await addMembership(ownerB, orgB, "owner");
});

describe("POST /ai/search", () => {
  it("returns only the caller's chunks when two tenants hold similar text", async () => {
    const documentA = await insertDocumentWithChunk({
      organizationId: orgA,
      filename: "a-runbook.md",
      content: "Roll back a bad deployment by redeploying the previous image.",
    });
    const documentB = await insertDocumentWithChunk({
      organizationId: orgB,
      filename: "b-runbook.md",
      content: "Roll back a bad deployment by redeploying the previous image.",
    });

    const response = await apiRequest<{
      query: string;
      totalResults: number;
      results: Array<{ sourceId: string; content: string }>;
    }>(server.url, "POST", "/ai/search", {
      ...auth(ownerA, orgA),
      body: { query: "roll back a bad deployment", limit: 5 },
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.query, "roll back a bad deployment");
    assert.ok(response.body.totalResults >= 1);
    assert.deepEqual(
      [...new Set(response.body.results.map((result) => result.sourceId))],
      [documentA]
    );
    assert.ok(
      !response.body.results.some((result) => result.sourceId === documentB),
      "another tenant's chunk must never be returned"
    );
  });

  it("rejects a foreign organization header before any retrieval runs", async () => {
    const response = await apiRequest(server.url, "POST", "/ai/search", {
      ...auth(ownerA, orgB),
      body: { query: "roll back a bad deployment" },
    });

    assert.equal(response.status, 403);
  });
});

describe("POST /ai/ask", () => {
  it("answers from the caller's evidence and cites only that source", async () => {
    const documentA = await insertDocumentWithChunk({
      organizationId: orgA,
      filename: "a-runbook.md",
      content: "The connection pool is exhausted by long-lived checkout transactions.",
    });
    await insertDocumentWithChunk({
      organizationId: orgB,
      filename: "b-runbook.md",
      content: "The connection pool is exhausted by long-lived checkout transactions.",
    });

    const response = await apiRequest<{
      answer: string;
      confidence: string;
      sources: Array<{ sourceId: string }>;
      sourceCount: number;
    }>(server.url, "POST", "/ai/ask", {
      ...auth(ownerA, orgA),
      body: { question: "Why is the connection pool exhausted?" },
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.match(response.body.answer, /connection pool is exhausted/);
    assert.equal(response.body.sourceCount, 1);
    assert.deepEqual(
      response.body.sources.map((source) => source.sourceId),
      [documentA]
    );
    assert.equal(llm.calls, 1, "exactly one generation call was made");
  });

  it("returns the no-context answer, and calls no model, for another tenant's evidence", async () => {
    await insertDocumentWithChunk({
      organizationId: orgA,
      filename: "a-runbook.md",
      content: "The connection pool is exhausted by long-lived checkout transactions.",
    });

    const callsBefore = llm.calls;

    const asOutsider = await apiRequest<{
      answer: string;
      confidence: string;
      sources: unknown[];
      sourceCount: number;
    }>(server.url, "POST", "/ai/ask", {
      ...auth(ownerB, orgB),
      body: { question: "Why is the connection pool exhausted?" },
    });

    assert.equal(asOutsider.status, 200, JSON.stringify(asOutsider.body));
    assert.equal(asOutsider.body.answer, NO_CONTEXT_ANSWER);
    assert.equal(asOutsider.body.confidence, "low");
    assert.deepEqual(asOutsider.body.sources, []);
    assert.equal(asOutsider.body.sourceCount, 0);
    assert.equal(llm.calls, callsBefore, "no context means no generation call");

    // The same question from the tenant that owns the evidence is answered:
    // the empty answer above is isolation, not a broken retrieval path.
    const asOwner = await apiRequest<{ answer: string; sourceCount: number }>(
      server.url,
      "POST",
      "/ai/ask",
      {
        ...auth(ownerA, orgA),
        body: { question: "Why is the connection pool exhausted?" },
      }
    );

    assert.equal(asOwner.status, 200);
    assert.notEqual(asOwner.body.answer, NO_CONTEXT_ANSWER);
    assert.equal(asOwner.body.sourceCount, 1);
    assert.equal(llm.calls, callsBefore + 1);
  });

  it("answers the no-context sentence for a tenant with no indexed sources at all", async () => {
    const response = await apiRequest<{
      answer: string;
      sources: unknown[];
      sourceCount: number;
    }>(server.url, "POST", "/ai/ask", {
      ...auth(ownerB, orgB),
      body: { question: "Which service caused the outage last night?" },
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.answer, NO_CONTEXT_ANSWER);
    assert.deepEqual(response.body.sources, []);
    assert.equal(response.body.sourceCount, 0);
  });
});

describe("GET /ai/health", () => {
  it("stays public, reports the scripted providers and carries no tenant data", async () => {
    const anonymous = await apiRequest<{
      healthy: boolean;
      provider: string;
      model: string;
      dimensions: number | null;
      generation: { provider: string; model: string; error?: string };
    }>(server.url, "GET", "/ai/health");

    assert.equal(anonymous.status, 200, JSON.stringify(anonymous.body));
    assert.equal(anonymous.body.healthy, true);
    assert.equal(anonymous.body.provider, "openai-compatible");
    assert.equal(anonymous.body.model, "test-embed");
    assert.equal(anonymous.body.dimensions, 768);
    assert.equal(anonymous.body.generation.provider, "gemini");
    assert.equal(typeof anonymous.body.generation.model, "string");
    assert.equal(anonymous.body.generation.error, undefined);

    // The payload is deployment metadata only. Two tenants (and no tenant) see
    // byte-identical bodies, because no organization is involved in producing it.
    const asA = await apiRequest<Record<string, unknown>>(
      server.url,
      "GET",
      "/ai/health",
      auth(ownerA, orgA)
    );
    const asB = await apiRequest<Record<string, unknown>>(
      server.url,
      "GET",
      "/ai/health",
      auth(ownerB, orgB)
    );

    assert.deepEqual(asA.body, anonymous.body);
    assert.deepEqual(asB.body, anonymous.body);

    const serialized = JSON.stringify(anonymous.body);
    assert.ok(!serialized.includes(orgA));
    assert.ok(!serialized.includes(orgB));
    assert.ok(!serialized.includes("owner@ai-a.example.test"));
  });
});
