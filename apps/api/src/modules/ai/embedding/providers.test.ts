import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createEmbeddingProvider,
  fixtureKeyOf,
  resetEmbeddingProvider,
} from "./index.js";
import { GeminiEmbeddingProvider } from "./gemini.provider.js";
import type { EmbeddingSettings } from "./settings.js";
import {
  EmbeddingConfigError,
  EmbeddingConnectionError,
  EmbeddingModelError,
} from "./errors.js";

function settings(overrides: Partial<EmbeddingSettings> = {}): EmbeddingSettings {
  return {
    provider: "ollama",
    model: "nomic-embed-text",
    dimensions: 768,
    ollamaUrl: "http://127.0.0.1:11434",
    baseUrl: null,
    apiKey: null,
    sendDimensions: false,
    fixturePath: "/nonexistent/embeddingFixtures.json",
    ...overrides,
  };
}

/** A fixture whose vectors are short on purpose; the conditional is the width. */
function writeFixture(
  body: { model: string; dimensions: number; vectors: Record<string, number[]> }
): { path: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opspilot-provider-"));
  const file = path.join(dir, "fixtures.json");
  fs.writeFileSync(file, JSON.stringify(body));

  return { path: file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/* ---------------------------------------------------------------- selector */

test("the provider is selected from settings, not from a single hard-coded backend", () => {
  assert.equal(createEmbeddingProvider(settings()).name, "ollama");

  assert.equal(
    createEmbeddingProvider(
      settings({ provider: "openai-compatible", baseUrl: "https://example.test/v1" })
    ).name,
    "openai-compatible"
  );

  assert.equal(createEmbeddingProvider(settings({ provider: "fixture" })).name, "fixture");

  assert.equal(
    createEmbeddingProvider(
      settings({ provider: "gemini", model: "gemini-embedding-001" })
    ).name,
    "gemini"
  );
});

test("an unknown provider is a configuration error, not a silent fallback", () => {
  assert.throws(
    () =>
      createEmbeddingProvider(
        settings({ provider: "huggingface" as EmbeddingSettings["provider"] })
      ),
    (error: unknown) =>
      error instanceof EmbeddingConfigError &&
      /Unknown EMBEDDING_PROVIDER/.test(error.message)
  );
});

/* ---------------------------------------------------------------- fixture */

test("fixture mode replays a recorded vector and reports the model it came from", async () => {
  const vector = [0.11, 0.22, 0.33, 0.44];
  const fixture = writeFixture({
    model: "recorded-model",
    dimensions: 4,
    vectors: { [fixtureKeyOf("alpha runbook")]: vector },
  });

  try {
    const provider = createEmbeddingProvider(
      settings({ provider: "fixture", dimensions: 4, fixturePath: fixture.path })
    );

    const batch = await provider.embed(["  alpha runbook  "]);
    assert.deepEqual(batch.embeddings, [vector]);
    // The model must describe the vectors, not the configured default.
    assert.equal(batch.model, "recorded-model");
    assert.equal(provider.model, "recorded-model");

    const probe = await provider.probe();
    assert.equal(probe.ok, true);
    assert.match(probe.message, /1 recorded vectors/);
  } finally {
    fixture.cleanup();
  }
});

test("fixture mode refuses text it never recorded instead of inventing a vector", async () => {
  const fixture = writeFixture({
    model: "recorded-model",
    dimensions: 4,
    vectors: { [fixtureKeyOf("alpha")]: [1, 0, 0, 0] },
  });

  try {
    const provider = createEmbeddingProvider(
      settings({ provider: "fixture", dimensions: 4, fixturePath: fixture.path })
    );

    await assert.rejects(
      () => provider.embed(["a document nobody recorded"]),
      (error: unknown) =>
        error instanceof EmbeddingModelError &&
        /has not been recorded/.test(error.message) &&
        /EMBEDDING_PROVIDER=openai-compatible or ollama/.test(error.message)
    );
  } finally {
    fixture.cleanup();
  }
});

test("a fixture recorded at another width is rejected, not silently mis-indexed", async () => {
  const fixture = writeFixture({
    model: "recorded-model",
    dimensions: 1024,
    vectors: { [fixtureKeyOf("alpha")]: [1, 0, 0, 0] },
  });

  try {
    const provider = createEmbeddingProvider(
      settings({ provider: "fixture", dimensions: 4, fixturePath: fixture.path })
    );

    const probe = await provider.probe();
    assert.equal(probe.ok, false);
    assert.match(probe.message, /stores 1024-dimension vectors/);

    await assert.rejects(
      () => provider.embed(["alpha"]),
      (error: unknown) =>
        error instanceof EmbeddingModelError && /1024-dimension/.test(error.message)
    );
  } finally {
    fixture.cleanup();
  }
});

test("the facade rejects a vector whose width does not match the stored schema", async () => {
  // A provider may answer at any width; only the service knows what the column
  // accepts, so the check has to live there too.
  const fixture = writeFixture({
    model: "recorded-model",
    dimensions: 4,
    vectors: { [fixtureKeyOf("alpha")]: [1, 0, 0] },
  });

  const previous = {
    provider: process.env.EMBEDDING_PROVIDER,
    dimensions: process.env.EMBEDDING_DIMENSIONS,
    fixturePath: process.env.EMBEDDING_FIXTURE_PATH,
  };

  process.env.EMBEDDING_PROVIDER = "fixture";
  process.env.EMBEDDING_DIMENSIONS = "4";
  process.env.EMBEDDING_FIXTURE_PATH = fixture.path;
  resetEmbeddingProvider();

  try {
    const { generateEmbeddings } = await import("../embedding.service.js");

    await assert.rejects(
      () => generateEmbeddings(["alpha"]),
      (error: unknown) =>
        error instanceof EmbeddingModelError &&
        /3-dimension vector but 4 is configured/.test(error.message)
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const name = `EMBEDDING_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }

    resetEmbeddingProvider();
    fixture.cleanup();
  }
});

/* ------------------------------------------------------ openai-compatible */

type CapturedRequest = {
  authorization: string | undefined;
  body: Record<string, unknown>;
};

async function startEmbeddingServer(
  payload: unknown
): Promise<{ url: string; requests: CapturedRequest[]; close: () => void }> {
  const requests: CapturedRequest[] = [];

  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(raw) as Record<string, unknown>,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => server.close(),
  };
}

test("the OpenAI-compatible adapter pairs vectors by index and sends the key", async () => {
  const server = await startEmbeddingServer({
    model: "server-model",
    // Deliberately out of order: pairing a vector with the wrong text would
    // poison the index without any visible error.
    data: [
      { index: 1, embedding: [0, 0, 0, 1] },
      { index: 0, embedding: [1, 0, 0, 0] },
    ],
  });

  try {
    const provider = createEmbeddingProvider(
      settings({
        provider: "openai-compatible",
        baseUrl: server.url,
        apiKey: "test-key",
        dimensions: 4,
        model: "server-model",
      })
    );

    const batch = await provider.embed(["first", "second"]);

    assert.deepEqual(batch.embeddings, [
      [1, 0, 0, 0],
      [0, 0, 0, 1],
    ]);
    assert.equal(batch.model, "server-model");

    const [captured] = server.requests;
    assert.equal(captured?.authorization, "Bearer test-key");
    assert.deepEqual(captured?.body.input, ["first", "second"]);
    // Only sent when the model supports truncated output.
    assert.equal(captured?.body.dimensions, undefined);
  } finally {
    server.close();
  }
});

test("EMBEDDING_SEND_DIMENSIONS passes the width for models that truncate", async () => {
  const server = await startEmbeddingServer({
    data: [{ index: 0, embedding: [1, 0, 0, 0] }],
  });

  try {
    const provider = createEmbeddingProvider(
      settings({
        provider: "openai-compatible",
        baseUrl: server.url,
        dimensions: 4,
        sendDimensions: true,
      })
    );

    await provider.embed(["first"]);
    assert.equal(server.requests[0]?.body.dimensions, 4);
  } finally {
    server.close();
  }
});

test("an unconfigured OpenAI-compatible provider explains itself instead of failing at boot", async () => {
  const provider = createEmbeddingProvider(
    settings({ provider: "openai-compatible", baseUrl: null })
  );

  // Constructing the provider must not throw: a missing URL should surface on
  // the health endpoint and on ingestion, not prevent the API from starting.
  const probe = await provider.probe();
  assert.equal(probe.ok, false);
  assert.match(probe.message, /EMBEDDING_BASE_URL is required/);

  await assert.rejects(
    () => provider.embed(["first"]),
    (error: unknown) => error instanceof EmbeddingConfigError
  );
});

/* ------------------------------------------------------------------ gemini */

type GeminiRequest = {
  method: string;
  url: string;
  apiKey: string | undefined;
  body: Record<string, unknown> | null;
};

/**
 * One server for both Gemini endpoints the provider uses: the embedding call is
 * a POST to `:batchEmbedContents`, the health probe is a GET of `/v1beta/models`.
 */
async function startGeminiServer(options: {
  /** One status, or a sequence consumed per batch call (the last repeats). */
  batchStatus?: number | number[];
  batch?: unknown;
  models?: unknown;
}): Promise<{ url: string; requests: GeminiRequest[]; close: () => void }> {
  const requests: GeminiRequest[] = [];
  let batchCalls = 0;

  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({
        method: request.method ?? "GET",
        url: request.url ?? "",
        apiKey: request.headers["x-goog-api-key"] as string | undefined,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      });

      const isBatch = (request.url ?? "").includes(":batchEmbedContents");
      const configured = options.batchStatus ?? 200;
      const status = Array.isArray(configured)
        ? configured[Math.min(batchCalls, configured.length - 1)]!
        : configured;
      if (isBatch) {
        batchCalls += 1;
      }

      response.writeHead(isBatch ? status : 200, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify(isBatch ? options.batch ?? {} : options.models ?? {})
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => server.close(),
  };
}

function geminiSettings(overrides: Partial<EmbeddingSettings> = {}): EmbeddingSettings {
  return settings({
    provider: "gemini",
    model: "gemini-embedding-001",
    apiKey: "test-key",
    ...overrides,
  });
}

test("the Gemini adapter asks for the stored width with a document task type and normalises", async () => {
  const server = await startGeminiServer({
    // Deliberately not unit length: the adapter must normalise, not the caller.
    batch: { embeddings: [{ values: [3, 4] }, { values: [0, 2] }] },
  });

  try {
    const provider = createEmbeddingProvider(
      geminiSettings({ baseUrl: server.url, dimensions: 2 })
    );

    const batch = await provider.embed(["doc one", "doc two"]);

    assert.deepEqual(batch.embeddings, [
      [0.6, 0.8],
      [0, 1],
    ]);
    assert.equal(batch.model, "gemini-embedding-001");

    const [captured] = server.requests;
    assert.equal(captured?.apiKey, "test-key");
    assert.match(captured?.url ?? "", /\/v1beta\/models\/gemini-embedding-001:batchEmbedContents$/);

    const requests = captured?.body?.requests as Record<string, unknown>[];
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], {
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: "doc one" }] },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: 2,
    });
  } finally {
    server.close();
  }
});

test("a query is embedded with the retrieval-query task type", async () => {
  const server = await startGeminiServer({
    batch: { embeddings: [{ values: [1, 0] }] },
  });

  try {
    const provider = createEmbeddingProvider(
      geminiSettings({ baseUrl: server.url, dimensions: 2 })
    );

    await provider.embed(["why is login slow"], "query");

    const requests = server.requests[0]?.body?.requests as Record<string, unknown>[];
    assert.equal(requests[0]?.taskType, "RETRIEVAL_QUERY");
  } finally {
    server.close();
  }
});

test("a Gemini response with the wrong number of vectors is rejected", async () => {
  const server = await startGeminiServer({
    batch: { embeddings: [{ values: [1, 0] }] },
  });

  try {
    const provider = createEmbeddingProvider(
      geminiSettings({ baseUrl: server.url, dimensions: 2 })
    );

    await assert.rejects(
      () => provider.embed(["first", "second"]),
      (error: unknown) =>
        error instanceof EmbeddingModelError &&
        /returned 1 vectors for 2 inputs/.test(error.message)
    );
  } finally {
    server.close();
  }
});

test("Gemini rate limiting and a missing model are distinct failures", async () => {
  const limited = await startGeminiServer({ batchStatus: 429, batch: {} });

  try {
    // No backoff entries: this asserts the exhausted path without sleeping.
    const provider = new GeminiEmbeddingProvider(
      geminiSettings({ baseUrl: limited.url, dimensions: 2 }),
      []
    );

    await assert.rejects(
      () => provider.embed(["first"]),
      (error: unknown) =>
        error instanceof EmbeddingConnectionError && /429/.test(error.message)
    );
  } finally {
    limited.close();
  }

  const missing = await startGeminiServer({ batchStatus: 404, batch: {} });

  try {
    const provider = createEmbeddingProvider(
      geminiSettings({ baseUrl: missing.url, dimensions: 2 })
    );

    await assert.rejects(
      () => provider.embed(["first"]),
      (error: unknown) =>
        error instanceof EmbeddingModelError && /not available for embedding/.test(error.message)
    );
  } finally {
    missing.close();
  }
});

test("a per-minute Gemini rate limit is retried, not failed", async () => {
  const server = await startGeminiServer({
    batchStatus: [429, 200],
    batch: { embeddings: [{ values: [1, 0] }] },
  });

  try {
    const provider = new GeminiEmbeddingProvider(
      geminiSettings({ baseUrl: server.url, dimensions: 2 }),
      [0]
    );

    const batch = await provider.embed(["first"]);

    assert.deepEqual(batch.embeddings, [[1, 0]]);
    assert.equal(server.requests.length, 2, "the retry must repeat the batch call");
  } finally {
    server.close();
  }
});

test("the Gemini health probe lists models instead of spending an embedding call", async () => {
  const server = await startGeminiServer({
    models: {
      models: [
        { name: "models/gemini-embedding-001" },
        { name: "models/gemini-2.5-flash" },
      ],
    },
  });

  try {
    const provider = createEmbeddingProvider(
      geminiSettings({ baseUrl: server.url, dimensions: 2 })
    );

    const probe = await provider.probe();
    assert.equal(probe.ok, true);

    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]?.method, "GET");
    assert.match(server.requests[0]?.url ?? "", /^\/v1beta\/models/);
  } finally {
    server.close();
  }
});

test("a model the service does not list makes the probe fail with the reason", async () => {
  const server = await startGeminiServer({
    models: { models: [{ name: "models/text-embedding-004" }] },
  });

  try {
    const provider = createEmbeddingProvider(
      geminiSettings({ baseUrl: server.url, dimensions: 2 })
    );

    const probe = await provider.probe();
    assert.equal(probe.ok, false);
    assert.match(probe.message, /does not list model 'gemini-embedding-001'/);
  } finally {
    server.close();
  }
});

test("a Gemini provider without a key explains itself instead of failing at boot", async () => {
  const provider = createEmbeddingProvider(
    geminiSettings({ apiKey: null, baseUrl: "https://example.test" })
  );

  const probe = await provider.probe();
  assert.equal(probe.ok, false);
  assert.match(probe.message, /GEMINI_API_KEY/);

  await assert.rejects(
    () => provider.embed(["first"]),
    (error: unknown) => error instanceof EmbeddingConfigError
  );
});

test("EMBEDDING_PROVIDER=gemini defaults to Gemini's own model, host and key", async () => {
  const previous = {
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
    OLLAMA_EMBEDDING_MODEL: process.env.OLLAMA_EMBEDDING_MODEL,
    EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL,
    EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };

  process.env.EMBEDDING_PROVIDER = "gemini";
  delete process.env.EMBEDDING_MODEL;
  delete process.env.OLLAMA_EMBEDDING_MODEL;
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.EMBEDDING_API_KEY;
  process.env.GEMINI_API_KEY = "from-gemini";

  try {
    const { readEmbeddingSettings } = await import("./settings.js");
    const read = readEmbeddingSettings();

    // Inheriting nomic's name here would send a model Gemini does not serve.
    assert.equal(read.model, "gemini-embedding-001");
    assert.equal(read.baseUrl, "https://generativelanguage.googleapis.com");
    assert.equal(read.apiKey, "from-gemini");
    assert.equal(read.provider, "gemini");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
