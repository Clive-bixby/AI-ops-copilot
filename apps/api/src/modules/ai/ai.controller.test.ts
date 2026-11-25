import assert from "node:assert/strict";
import test from "node:test";

import { aiHealthController, describeGeneration } from "./ai.controller.js";
import { resetEmbeddingProvider } from "./embedding/index.js";

/**
 * `/ai/health` exists so a deployment can be inspected without calling a
 * provider. It used to describe embeddings only, which meant it stayed green
 * while every analysis pointed at a model that had been retired, so these tests
 * pin the generation block to configuration rather than to a live call.
 */

const ENV_NAMES = [
  "LLM_PROVIDER",
  "LLM_MODEL",
  "GEMINI_MODEL",
  "LLM_FALLBACK_ENABLED",
  "LLM_FALLBACK_PROVIDER",
  "LLM_FALLBACK_MODEL",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_FIXTURE_PATH",
] as const;

type CapturedResponse = {
  statusCode: number | null;
  body: Record<string, unknown> | null;
  status(code: number): CapturedResponse;
  json(payload: Record<string, unknown>): CapturedResponse;
};

/**
 * `asyncHandler` returns void, so the response is what tells us the handler is
 * finished: resolve on `json`, or reject on `next`, which is where an
 * unhandled error would otherwise disappear.
 */
async function callHealth(
  response: CapturedResponse
): Promise<Record<string, unknown>> {
  let settle: (error: Error | null) => void = () => undefined;
  const finished = new Promise<Error | null>((resolve) => {
    settle = resolve;
  });

  const timer = setTimeout(
    () => settle(new Error("/ai/health never answered or called next")),
    5_000
  );

  response.status = (code: number) => {
    response.statusCode = code;
    return response;
  };
  response.json = (payload: Record<string, unknown>) => {
    response.body = payload;
    settle(null);
    return response;
  };

  try {
    aiHealthController(
      {} as never,
      response as never,
      ((error?: unknown) => settle(error instanceof Error ? error : new Error(String(error)))) as never
    );

    const error = await finished;

    if (error !== null) {
      throw error;
    }

    return response.body ?? {};
  } finally {
    clearTimeout(timer);
  }
}

/** Run a case with only the environment it sets, restoring everything after. */
async function withEnvironment(
  values: Partial<Record<(typeof ENV_NAMES)[number], string>>,
  run: () => Promise<void>
): Promise<void> {
  const previous = Object.fromEntries(
    ENV_NAMES.map((name) => [name, process.env[name]])
  );

  try {
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined) {
        process.env[name] = value;
      }
    }
    resetEmbeddingProvider();
    await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetEmbeddingProvider();
  }
}

function fakeResponse(): CapturedResponse {
  const response: CapturedResponse = {
    statusCode: null,
    body: null,
    status(code) {
      response.statusCode = code;
      return response;
    },
    json(payload) {
      response.body = payload;
      return response;
    },
  };

  return response;
}

test("the health payload names the generation model, not only the embedder", async () => {
  await withEnvironment(
    {
      EMBEDDING_PROVIDER: "fixture",
      EMBEDDING_MODEL: "nomic-embed-text",
    },
    async () => {
      const response = fakeResponse();
      const body = await callHealth(response);

      // The checked-in fixture holds vectors, so this is a real healthy answer
      // with no network and no provider call.
      assert.equal(response.statusCode, 200);
      assert.equal(body.provider, "fixture");
      assert.match(String(body.message), /recorded vectors/);
      assert.deepEqual(body.generation, {
        provider: "gemini",
        model: "gemini-3.5-flash-lite",
        fallback: null,
      });
    }
  );
});

test("an enabled fallback is named so a silent switch is visible", async () => {
  await withEnvironment(
    {
      LLM_MODEL: "gemini-2.5-flash",
      LLM_FALLBACK_ENABLED: "true",
      LLM_FALLBACK_PROVIDER: "openai-compatible",
      LLM_FALLBACK_MODEL: "openai/gpt-oss-120b",
    },
    async () => {
      assert.deepEqual(describeGeneration(), {
        provider: "gemini",
        model: "gemini-2.5-flash",
        fallback: "openai-compatible/openai/gpt-oss-120b",
      });
    }
  );
});

test("a misconfigured provider is reported instead of thrown", async () => {
  await withEnvironment({ LLM_PROVIDER: "not-a-provider" }, async () => {
    const generation = describeGeneration() as {
      provider: string;
      model: string;
      error?: string;
    };

    assert.equal(generation.provider, "not-a-provider");
    assert.equal(generation.model, "unconfigured");
    assert.match(String(generation.error), /Unknown LLM_PROVIDER/);
  });
});
