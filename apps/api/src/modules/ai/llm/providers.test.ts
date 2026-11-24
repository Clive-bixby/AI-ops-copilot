import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { LlmConfigError, LlmProviderError, LlmTimeoutError } from "./errors.js";
import {
  createLlmProvider,
  getLlmProvider,
  readLlmSettings,
  resetLlmProvider,
} from "./index.js";
import type { LlmProviderSettings, LlmSettings } from "./settings.js";

/**
 * These tests never touch a provider. A local HTTP server answers in the exact
 * shape Gemini and the OpenAI-compatible APIs do, so the request the application
 * would send -- and the error it would map -- is the real one.
 */

type ScriptedResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Leave the request open so the client's own timeout fires. */
  hang?: boolean;
};

type CapturedRequest = {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
};

async function startServer(queue: ScriptedResponse[]): Promise<{
  url: string;
  requests: CapturedRequest[];
  close: () => void;
}> {
  const requests: CapturedRequest[] = [];
  const pending = [...queue];

  const server = http.createServer((request, response) => {
    let raw = "";

    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });

    request.on("end", () => {
      requests.push({
        path: request.url ?? "",
        headers: request.headers,
        body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
      });

      const scripted = pending.shift() ?? { status: 200, body: {} };

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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

function geminiSettings(overrides: Partial<LlmProviderSettings> = {}): LlmProviderSettings {
  return {
    provider: "gemini",
    model: "gemini-2.5-flash-lite",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "test-key",
    apiKeyName: "GEMINI_API_KEY",
    timeoutMs: 2_000,
    maxRetries: 0,
    baseDelayMs: 1,
    ...overrides,
  };
}

function openAiSettings(
  baseUrl: string,
  overrides: Partial<LlmProviderSettings> = {}
): LlmProviderSettings {
  return {
    provider: "openai-compatible",
    model: "openai/gpt-oss-120b",
    baseUrl,
    apiKey: "test-key",
    apiKeyName: "LLM_API_KEY",
    timeoutMs: 2_000,
    maxRetries: 0,
    baseDelayMs: 1,
    ...overrides,
  };
}

function geminiAnswer(text: string) {
  return {
    status: 200,
    body: {
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1_200, candidatesTokenCount: 80 },
    },
  };
}

function generationConfig(request: CapturedRequest): Record<string, unknown> {
  return (request.body.generationConfig ?? {}) as Record<string, unknown>;
}

/* ------------------------------------------------------------- gemini --- */

test("a prose request is not asked for a JSON response", async () => {
  const server = await startServer([geminiAnswer("The pool is exhausted.")]);

  try {
    const provider = createLlmProvider({
      ...geminiSettings({ baseUrl: server.url }),
      fallback: null,
    });

    const result = await provider.generate({
      prompt: "How do we recover from pool exhaustion?",
      responseFormat: "text",
      temperature: 0.1,
      topP: 0.8,
      maxOutputTokens: 700,
    });

    const [request] = server.requests;
    assert.equal(
      request?.path,
      "/v1beta/models/gemini-2.5-flash-lite:generateContent"
    );
    assert.equal(request?.headers["x-goog-api-key"], "test-key");

    const config = generationConfig(request!);
    assert.equal(config.responseMimeType, undefined);
    assert.equal(config.temperature, 0.1);
    assert.equal(config.topP, 0.8);
    assert.equal(config.maxOutputTokens, 700);

    assert.equal(result.text, "The pool is exhausted.");
    assert.equal(result.provider, "gemini");
    assert.equal(result.model, "gemini-2.5-flash-lite");
    assert.equal(result.attempts, 1);
    assert.equal(result.usedFallback, false);
    assert.deepEqual(result.usage, { inputTokens: 1_200, outputTokens: 80 });
  } finally {
    server.close();
  }
});

test("a structured request constrains the response format and passes a schema", async () => {
  const server = await startServer([geminiAnswer('{"summary":"ok"}')]);

  try {
    const provider = createLlmProvider({
      ...geminiSettings({ baseUrl: server.url }),
      fallback: null,
    });

    await provider.generate({
      prompt: "Analyse this investigation.",
      responseFormat: "json",
      jsonSchema: { type: "object" },
    });

    const config = generationConfig(server.requests[0]!);
    assert.equal(config.responseMimeType, "application/json");
    assert.deepEqual(config.responseSchema, { type: "object" });
  } finally {
    server.close();
  }
});

test("a 429 is retried and Retry-After is honoured", async () => {
  const server = await startServer([
    { status: 429, headers: { "retry-after": "0" }, body: { error: {} } },
    geminiAnswer("second attempt"),
  ]);

  try {
    const provider = createLlmProvider({
      ...geminiSettings({ baseUrl: server.url, maxRetries: 2 }),
      fallback: null,
    });

    const startedAt = Date.now();
    const result = await provider.generate({ prompt: "hello" });

    assert.equal(server.requests.length, 2);
    assert.equal(result.attempts, 2);
    assert.equal(result.text, "second attempt");
    // Retry-After: 0 must not be replaced by a multi-second backoff.
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    server.close();
  }
});

test("a rejected credential is not retried and never echoes the key", async () => {
  const server = await startServer([
    { status: 401, body: { error: { message: "API key not valid" } } },
  ]);

  try {
    const provider = createLlmProvider({
      ...geminiSettings({ baseUrl: server.url, maxRetries: 3 }),
      fallback: null,
    });

    await assert.rejects(
      () => provider.generate({ prompt: "hello" }),
      (error: unknown) => {
        assert.ok(error instanceof LlmProviderError);
        assert.equal(error.status, 401);
        assert.match(error.message, /GEMINI_API_KEY/);
        assert.doesNotMatch(error.message, /test-key/);
        return true;
      }
    );

    // Retrying a bad key spends quota to get the same answer.
    assert.equal(server.requests.length, 1);
  } finally {
    server.close();
  }
});

test("a persistent 5xx consumes the retry budget and keeps its status", async () => {
  const server = await startServer([
    { status: 503 },
    { status: 503 },
    { status: 503 },
  ]);

  try {
    const provider = createLlmProvider({
      ...geminiSettings({ baseUrl: server.url, maxRetries: 2 }),
      fallback: null,
    });

    await assert.rejects(
      () => provider.generate({ prompt: "hello" }),
      (error: unknown) =>
        error instanceof LlmProviderError && error.status === 503
    );

    assert.equal(server.requests.length, 3);
  } finally {
    server.close();
  }
});

test("a provider that never answers surfaces as a timeout, not a 502", async () => {
  const server = await startServer([{ status: 200, hang: true }]);

  try {
    const provider = createLlmProvider({
      ...geminiSettings({ baseUrl: server.url, timeoutMs: 100 }),
      fallback: null,
    });

    await assert.rejects(
      () => provider.generate({ prompt: "hello" }),
      (error: unknown) => error instanceof LlmTimeoutError
    );
  } finally {
    server.close();
  }
});

test("a missing key is a configuration error that names the variable", async () => {
  const provider = createLlmProvider({
    ...geminiSettings({ apiKey: null }),
    fallback: null,
  });

  await assert.rejects(
    () => provider.generate({ prompt: "hello" }),
    (error: unknown) =>
      error instanceof LlmConfigError && /GEMINI_API_KEY/.test(error.message)
  );
});

/* -------------------------------------------------- openai-compatible --- */

test("the OpenAI-compatible adapter sends json_object and reads token usage", async () => {
  const server = await startServer([
    {
      status: 200,
      body: {
        choices: [{ message: { content: '{"summary":"ok"}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 900, completion_tokens: 120 },
      },
    },
  ]);

  try {
    const provider = createLlmProvider({
      ...openAiSettings(server.url),
      fallback: null,
    });

    const result = await provider.generate({
      prompt: "Analyse this investigation.",
      responseFormat: "json",
      maxOutputTokens: 1_600,
    });

    const [request] = server.requests;
    assert.equal(request?.path, "/chat/completions");
    assert.equal(request?.headers.authorization, "Bearer test-key");
    assert.deepEqual(request?.body.response_format, { type: "json_object" });
    assert.deepEqual(request?.body.messages, [
      { role: "user", content: "Analyse this investigation." },
    ]);
    assert.equal(request?.body.max_tokens, 1_600);

    assert.equal(result.text, '{"summary":"ok"}');
    assert.equal(result.provider, "openai-compatible");
    assert.deepEqual(result.usage, { inputTokens: 900, outputTokens: 120 });
  } finally {
    server.close();
  }
});

/* ---------------------------------------------------------- fallback --- */

test("fallback stays off unless it is explicitly enabled", () => {
  const previous = {
    ENABLED: process.env.LLM_FALLBACK_ENABLED,
    PROVIDER: process.env.LLM_FALLBACK_PROVIDER,
    MODEL: process.env.LLM_FALLBACK_MODEL,
  };

  process.env.LLM_FALLBACK_PROVIDER = "openai-compatible";
  process.env.LLM_FALLBACK_MODEL = "openai/gpt-oss-120b";
  delete process.env.LLM_FALLBACK_ENABLED;

  try {
    assert.equal(readLlmSettings().fallback, null);

    process.env.LLM_FALLBACK_ENABLED = "true";
    const enabled = readLlmSettings().fallback;
    assert.equal(enabled?.provider, "openai-compatible");
    assert.equal(enabled?.model, "openai/gpt-oss-120b");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const name = `LLM_FALLBACK_${key}`;
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("an enabled fallback answers only after the primary fails, and names itself", async () => {
  const primary = await startServer([{ status: 503 }]);
  const secondary = await startServer([
    {
      status: 200,
      body: {
        choices: [{ message: { content: '{"summary":"from fallback"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    },
  ]);

  try {
    const settings: LlmSettings = {
      ...geminiSettings({ baseUrl: primary.url, maxRetries: 0 }),
      fallback: openAiSettings(secondary.url),
    };

    const result = await createLlmProvider(settings).generate({
      prompt: "Analyse this investigation.",
      responseFormat: "json",
    });

    assert.equal(result.text, '{"summary":"from fallback"}');
    // Attribution: the record must not say gemini produced this.
    assert.equal(result.provider, "openai-compatible");
    assert.equal(result.model, "openai/gpt-oss-120b");
    assert.equal(result.usedFallback, true);
  } finally {
    primary.close();
    secondary.close();
  }
});

test("a successful primary is never labelled as a fallback", async () => {
  const primary = await startServer([geminiAnswer("primary")]);
  const secondary = await startServer([{ status: 500 }]);

  try {
    const result = await createLlmProvider({
      ...geminiSettings({ baseUrl: primary.url }),
      fallback: openAiSettings(secondary.url),
    }).generate({ prompt: "hello" });

    assert.equal(result.text, "primary");
    assert.equal(result.provider, "gemini");
    assert.equal(result.usedFallback, false);
    assert.equal(secondary.requests.length, 0);
  } finally {
    primary.close();
    secondary.close();
  }
});

/* ------------------------------------------------------- observability --- */

test("logs carry counts and never the prompt or the key", async () => {
  const server = await startServer([geminiAnswer("ok")]);
  const logged: string[] = [];
  const original = console.log;

  console.log = (...args: unknown[]) => {
    logged.push(JSON.stringify(args));
  };

  try {
    const provider = createLlmProvider({
      ...geminiSettings({ baseUrl: server.url }),
      fallback: null,
    });

    await provider.generate({ prompt: "RDS_PASSWORD=hunter2 what failed?" });
  } finally {
    console.log = original;
    server.close();
  }

  const output = logged.join("\n");
  assert.match(output, /llm\.completed/);
  assert.match(output, /promptChars/);
  // Retrieved evidence is in the prompt; a demo's console is public.
  assert.doesNotMatch(output, /hunter2/);
  assert.doesNotMatch(output, /test-key/);
});

/* ------------------------------------------------------------ settings --- */

test("model precedence keeps the existing default and allows per-feature overrides", () => {
  const names = [
    "LLM_PROVIDER",
    "LLM_MODEL",
    "GEMINI_MODEL",
    "RAG_LLM_MODEL",
    "ANALYSIS_LLM_MODEL",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  try {
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_MODEL;
    delete process.env.RAG_LLM_MODEL;
    delete process.env.ANALYSIS_LLM_MODEL;
    process.env.GEMINI_MODEL = "gemini-2.5-flash-lite";

    // Unmodified environment: exactly the model the application used before.
    assert.equal(readLlmSettings("rag").model, "gemini-2.5-flash-lite");
    assert.equal(readLlmSettings("analysis").provider, "gemini");

    process.env.LLM_MODEL = "gemini-2.5-flash";
    assert.equal(readLlmSettings("rag").model, "gemini-2.5-flash");

    process.env.RAG_LLM_MODEL = "gemini-2.5-flash-lite";
    assert.equal(readLlmSettings("rag").model, "gemini-2.5-flash-lite");
    assert.equal(readLlmSettings("analysis").model, "gemini-2.5-flash");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("an OpenAI-compatible deployment without a model fails loudly, not silently", async () => {
  const previous = {
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    LLM_MODEL: process.env.LLM_MODEL,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
  };

  process.env.LLM_PROVIDER = "openai-compatible";
  process.env.LLM_BASE_URL = "https://api.groq.com/openai/v1";
  delete process.env.LLM_MODEL;

  try {
    resetLlmProvider();

    assert.throws(
      () => getLlmProvider("analysis"),
      (error: unknown) =>
        error instanceof LlmConfigError && /LLM_MODEL is required/.test(error.message)
    );
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }

    resetLlmProvider();
  }
});
