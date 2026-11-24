import assert from "node:assert/strict";
import test from "node:test";

import { resetLlmProvider } from "../ai/llm/index.js";
import {
  RAGProviderConfigError,
  RAGProviderError,
  RAGProviderTimeoutError,
} from "../ai/rag.service.js";
import {
  generateJsonResponse,
  getAnalysisGenerationIdentity,
} from "./analysis.provider.js";

/**
 * Configuration failures must reach the client as the endpoint's provider error
 * (502), not as an unhandled exception (500).
 *
 * Both investigation paths end in `generateJsonResponse`: analysis calls it after
 * reading the identity it records on the run, follow-ups call it directly. A bad
 * provider name fails at the settings read, so it needs its own mapping; a
 * missing model fails inside the client, where the mapper already lives.
 */

const MANAGED_ENV = [
  "LLM_PROVIDER",
  "LLM_MODEL",
  "GEMINI_MODEL",
  "GEMINI_API_KEY",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "GEMINI_API_BASE_URL",
  "LLM_MAX_RETRIES",
  "LLM_RETRY_BASE_DELAY_MS",
  "ANALYSIS_LLM_MODEL",
  "LLM_FALLBACK_ENABLED",
  "LLM_FALLBACK_PROVIDER",
  "LLM_FALLBACK_MODEL",
  "LLM_FALLBACK_BASE_URL",
  "LLM_FALLBACK_API_KEY",
] as const;

type ManagedEnv = (typeof MANAGED_ENV)[number];

/**
 * Apply exactly the variables a case needs and nothing else, so an inherited
 * shell setting cannot decide what the test measures.
 */
function withEnv(values: Partial<Record<ManagedEnv, string>>): () => void {
  const previous = new Map<string, string | undefined>();

  for (const name of MANAGED_ENV) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }

  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) {
      process.env[name] = value;
    }
  }

  resetLlmProvider();

  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }

    resetLlmProvider();
  };
}

test("an unknown provider name is a provider error, not a timeout", () => {
  const restore = withEnv({ LLM_PROVIDER: "groq" });

  try {
    assert.throws(
      () => getAnalysisGenerationIdentity(),
      (error: unknown) => {
        assert.ok(error instanceof RAGProviderError);
        // 502, not 504: this is a deployment mistake, not a slow provider.
        assert.ok(!(error instanceof RAGProviderTimeoutError));
        // The configuration subclass is what keeps the message in the body.
        assert.ok(error instanceof RAGProviderConfigError);
        assert.match(error.message, /Unknown LLM_PROVIDER "groq"/);
        assert.match(error.message, /gemini, openai-compatible/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("the same bad provider name is reported when generation itself is attempted", async () => {
  // Follow-ups call generateJsonResponse without reading the identity first.
  const restore = withEnv({ LLM_PROVIDER: "litellm" });

  try {
    await assert.rejects(
      () => generateJsonResponse("Analyse this investigation."),
      (error: unknown) =>
        error instanceof RAGProviderError &&
        /Unknown LLM_PROVIDER "litellm"/.test(error.message)
    );
  } finally {
    restore();
  }
});

test("a missing model on the OpenAI-compatible provider is a provider error", async () => {
  const restore = withEnv({
    LLM_PROVIDER: "openai-compatible",
    LLM_BASE_URL: "https://api.groq.com/openai/v1",
  });

  try {
    // No LLM_MODEL: the model cannot be guessed from a vendor-neutral base URL.
    await assert.rejects(
      () => generateJsonResponse("Analyse this investigation."),
      (error: unknown) => {
        assert.ok(error instanceof RAGProviderError);
        assert.ok(error instanceof RAGProviderConfigError);
        assert.match(error.message, /LLM_MODEL is required/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("an unknown fallback provider is reported before any request is made", () => {
  const restore = withEnv({
    LLM_PROVIDER: "gemini",
    GEMINI_MODEL: "gemini-2.5-flash-lite",
    LLM_FALLBACK_ENABLED: "true",
    LLM_FALLBACK_PROVIDER: "litellm",
    LLM_FALLBACK_MODEL: "openai/gpt-oss-120b",
  });

  try {
    assert.throws(
      () => getAnalysisGenerationIdentity(),
      (error: unknown) =>
        error instanceof RAGProviderError &&
        /Unknown LLM_FALLBACK_PROVIDER "litellm"/.test(error.message)
    );
  } finally {
    restore();
  }
});

test("a valid configuration still reports the provider and model it will use", () => {
  const restore = withEnv({ GEMINI_MODEL: "gemini-2.5-flash" });

  try {
    assert.deepEqual(getAnalysisGenerationIdentity(), {
      provider: "gemini",
      model: "gemini-2.5-flash",
    });
  } finally {
    restore();
  }
});
