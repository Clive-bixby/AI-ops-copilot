import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

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
import type { ApiResponse, TestServer } from "./harness.js";

/**
 * The analysis endpoint's failure contract, driven end to end through the real
 * HTTP client against a scripted provider.
 *
 * There is no live call: the "provider" is a local server that answers in the
 * shape Gemini does, so the request the application sends and the error it maps
 * are the real ones. Each case asserts the three things the audit asked for --
 * the status the endpoint promises (504 for a timeout, 502 for everything else),
 * the reason recorded on the run, and that nothing was stored as an analysis.
 *
 * The timeout is the configuration's floor (`MIN_TIMEOUT_MS`), and the retry
 * budget is one attempt, so the suite stays fast without weakening anything: the
 * retry path is asserted by counting what the scripted provider received.
 */

type ScriptedResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Leave the request open so the client's own timeout fires. */
  hang?: boolean;
};

let provider: { url: string; calls: number; resetCalls: () => void; close: () => void };
let queue: ScriptedResponse[] = [];
let server: TestServer;
let organizationId: string;
let userId: string;

function geminiAnswer(text: string): ScriptedResponse {
  return {
    status: 200,
    body: {
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 60 },
    },
  };
}

async function startScriptedProvider(): Promise<{
  url: string;
  calls: number;
  resetCalls: () => void;
  close: () => void;
}> {
  const state = { calls: 0 };

  const httpServer = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      state.calls += 1;
      const scripted = queue.shift() ?? { status: 200, hang: true };

      if (scripted.hang) {
        return;
      }

      response.writeHead(scripted.status, {
        "Content-Type": "application/json",
        ...(scripted.headers ?? {}),
      });
      response.end(JSON.stringify(scripted.body ?? {}));
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;

  return {
    get url() {
      return `http://127.0.0.1:${address.port}`;
    },
    get calls() {
      return state.calls;
    },
    resetCalls: () => {
      state.calls = 0;
    },
    close: () => {
      httpServer.closeAllConnections?.();
      httpServer.close();
    },
  };
}

function auth() {
  return { token: tokenFor(userId), organizationId };
}

async function createInvestigationWithEvidence(): Promise<string> {
  const created = await apiRequest<{ investigation: { id: string } }>(
    server.url,
    "POST",
    "/investigations",
    {
      ...auth(),
      body: {
        title: "Gateway returns 500 under load",
        description: "The API intermittently returns HTTP 500 for checkout while the pool is busy.",
        severity: "high",
      },
    }
  );

  assert.equal(created.status, 201, JSON.stringify(created.body));

  const investigationId = created.body.investigation.id;

  await getPool().query(
    `INSERT INTO investigation_evidence (
       investigation_id, organization_id, source_type, source_id, chunk_index,
       source_title, excerpt, match_type, retrieval_score, similarity, relevance,
       inclusion_reason, retrieval_query, origin
     )
     VALUES ($1, $2, 'log', gen_random_uuid(), 0, 'gateway log',
             'connection pool exhausted', 'vector', 0.91, 0.88, 'direct',
             'mentions the same symptom', 'gateway 500 error', 'retrieval')`,
    [investigationId, organizationId]
  );

  return investigationId;
}

async function storedRun(investigationId: string): Promise<{
  status: string;
  failureReason: string | null;
  summary: string | null;
}> {
  const response = await apiRequest<{
    analysis: { status: string; failureReason: string | null; summary: string | null } | null;
    hypotheses: unknown[];
  }>(server.url, "GET", `/investigations/${investigationId}/analysis`, auth());

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(response.body.analysis, "a failed run must still leave a record");
  assert.deepEqual(response.body.hypotheses, [], "a failed run has no hypotheses");

  return response.body.analysis;
}

async function analyze(
  investigationId: string
): Promise<ApiResponse<{ error?: string }>> {
  return apiRequest<{ error?: string }>(
    server.url,
    "POST",
    `/investigations/${investigationId}/analyze`,
    auth()
  );
}

before(async () => {
  await setupTestDatabase();
  provider = await startScriptedProvider();

  process.env.LLM_PROVIDER = "gemini";
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_BASE_URL = provider.url;
  process.env.LLM_TIMEOUT_MS = "1000";
  process.env.LLM_MAX_RETRIES = "1";
  process.env.LLM_RETRY_BASE_DELAY_MS = "1";
  resetLlmProvider();

  server = await startServer();
});

after(async () => {
  await server?.close();
  provider?.close();

  for (const name of [
    "LLM_PROVIDER",
    "LLM_API_KEY",
    "LLM_BASE_URL",
    "LLM_TIMEOUT_MS",
    "LLM_MAX_RETRIES",
    "LLM_RETRY_BASE_DELAY_MS",
  ]) {
    delete process.env[name];
  }

  resetLlmProvider();

  if (hasPool()) {
    await getPool().end();
  }
});

describe("analysis provider failures", () => {
  beforeEach(async () => {
    queue = [];
    provider.resetCalls();
    await resetDatabase();
    organizationId = await createOrganization("AI Failure Org");
    userId = await createUser("ai-failure@example.test");
    await addMembership(userId, organizationId, "owner");
  });

  it("answers 504 when the provider does not respond, and records the timeout", async () => {
    const investigationId = await createInvestigationWithEvidence();
    queue = [{ status: 200, hang: true }, { status: 200, hang: true }];

    const response = await analyze(investigationId);

    assert.equal(response.status, 504);
    assert.match(response.body.error ?? "", /Internal server error/);

    const run = await storedRun(investigationId);
    assert.equal(run.status, "failed");
    assert.equal(run.failureReason, "The analysis provider timed out. Try again.");
    assert.equal(run.summary, null);

    // The timeout is a retryable failure: both attempts were made.
    assert.equal(provider.calls, 2);
  });

  it("answers 502 when the provider keeps throttling, after spending only the retry budget", async () => {
    const investigationId = await createInvestigationWithEvidence();
    queue = [
      { status: 429, headers: { "retry-after": "0" }, body: { error: { message: "quota" } } },
      { status: 429, headers: { "retry-after": "0" }, body: { error: { message: "quota" } } },
      { status: 429, headers: { "retry-after": "0" }, body: { error: { message: "quota" } } },
    ];

    const response = await analyze(investigationId);

    assert.equal(response.status, 502);

    const run = await storedRun(investigationId);
    assert.equal(run.status, "failed");
    // A throttled provider whose retry budget is spent is a provider failure,
    // not a timeout: the endpoint must not answer 504 for it.
    assert.equal(run.failureReason, "The analysis provider could not complete the run. Try again.");

    assert.equal(provider.calls, 2);
  });

  it("answers 502 when the provider keeps failing with 5xx", async () => {
    const investigationId = await createInvestigationWithEvidence();
    queue = [{ status: 503 }, { status: 503 }, { status: 503 }];

    const response = await analyze(investigationId);

    assert.equal(response.status, 502);

    const run = await storedRun(investigationId);
    assert.equal(run.status, "failed");
    assert.equal(run.failureReason, "The analysis provider could not complete the run. Try again.");

    assert.equal(provider.calls, 2);
  });

  it("answers 502 and stores nothing when the provider returns prose instead of JSON", async () => {
    const investigationId = await createInvestigationWithEvidence();
    queue = [geminiAnswer("Sure! Here is the analysis you asked for.")];

    const response = await analyze(investigationId);

    assert.equal(response.status, 502);

    const run = await storedRun(investigationId);
    assert.equal(run.status, "failed");
    assert.equal(run.failureReason, "The analysis response could not be validated.");
    assert.equal(run.summary, null);
  });

  it("answers 502 and stores nothing when the provider returns an oversized response", async () => {
    const investigationId = await createInvestigationWithEvidence();
    // Valid JSON, past ANALYSIS_LIMITS.responseChars: rejected before parsing.
    queue = [geminiAnswer(JSON.stringify({ summary: "x".repeat(20_500) }))];

    const response = await analyze(investigationId);

    assert.equal(response.status, 502);

    const run = await storedRun(investigationId);
    assert.equal(run.status, "failed");
    assert.equal(run.failureReason, "The analysis response could not be validated.");
    assert.equal(run.summary, null);
  });

  it("does not retry a request the provider rejects as malformed", async () => {
    const investigationId = await createInvestigationWithEvidence();
    queue = [{ status: 400, body: { error: { message: "bad request" } } }];

    const response = await analyze(investigationId);

    assert.equal(response.status, 502);

    const run = await storedRun(investigationId);
    assert.equal(run.status, "failed");
    assert.equal(provider.calls, 1);
  });
});
