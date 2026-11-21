import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import axios from "axios";

/**
 * Fixture-backed stand-in for Ollama's embedding endpoints.
 *
 * The investigation evaluation needs real semantic similarity, but CI must not
 * download a model or depend on Ollama. This server replays vectors recorded
 * once from `nomic-embed-text` on the same texts the evaluation embeds. A text
 * that is not in the fixture is a hard error rather than a placeholder vector:
 * a made-up embedding would let the evaluation pass while measuring nothing.
 *
 * Record (needs a running Ollama):
 *   UPSTREAM_OLLAMA_URL=http://localhost:11434 OLLAMA_URL=http://127.0.0.1:8799 \
 *     npx tsx src/scripts/embeddingFixtureServer.ts --record
 *   npm run eval:investigations
 *
 * Replay (CI):
 *   npx tsx src/scripts/embeddingFixtureServer.ts &
 *   OLLAMA_URL=http://127.0.0.1:8799 npm run eval:investigations
 */

const defaultFixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../evaluation/embeddingFixtures.json"
);

const fixturePath = process.env.EMBEDDING_FIXTURE_PATH
  ? path.resolve(process.env.EMBEDDING_FIXTURE_PATH)
  : defaultFixturePath;

const port = Number(process.env.EMBEDDING_STUB_PORT ?? 8799);
const record = process.argv.includes("--record");
const upstream = (
  process.env.UPSTREAM_OLLAMA_URL ||
  process.env.OLLAMA_URL ||
  "http://localhost:11434"
).replace(/\/+$/, "");
const model = (
  process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text"
).trim();
const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 768);

type Fixture = {
  model: string;
  dimensions: number;
  /** sha256 of the trimmed text → recorded vector. */
  vectors: Record<string, number[]>;
};

function loadFixture(): Fixture {
  if (!fs.existsSync(fixturePath)) {
    return { model, dimensions, vectors: {} };
  }

  const parsed = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;

  if (parsed.dimensions !== dimensions) {
    throw new Error(
      `Fixture ${fixturePath} stores ${parsed.dimensions}-dimension vectors but ${dimensions} is configured. ` +
        "Re-record the fixture or fix EMBEDDING_DIMENSIONS."
    );
  }

  return parsed;
}

const fixture = loadFixture();
let dirty = false;

function saveFixture(): void {
  const ordered: Fixture = {
    model: fixture.model,
    dimensions: fixture.dimensions,
    vectors: Object.fromEntries(
      Object.entries(fixture.vectors).sort(([a], [b]) => a.localeCompare(b))
    ),
  };

  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  const temporary = `${fixturePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(ordered, null, 0)}\n`);
  fs.renameSync(temporary, fixturePath);
}

/**
 * Log-group chunks embed their absolute window start and end, so the same log
 * template would hash differently on every run. Timestamps are therefore
 * blanked before hashing: they carry no meaning for similarity, while the
 * template, level, service and sample events still identify the text.
 */
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

function keyOf(text: string): string {
  return createHash("sha256")
    .update(text.trim().replace(ISO_TIMESTAMP, "<timestamp>"))
    .digest("hex");
}

class FixtureMissError extends Error {
  constructor(readonly key: string) {
    super(`No recorded embedding for ${key}`);
    this.name = "FixtureMissError";
  }
}

async function recordVector(text: string): Promise<number[]> {
  const response = await axios.post<{ embedding: number[] }>(
    `${upstream}/api/embeddings`,
    { model, prompt: text.trim() },
    { timeout: 120_000, headers: { "Content-Type": "application/json" } }
  );

  const embedding = response.data.embedding;
  if (!Array.isArray(embedding) || embedding.length !== dimensions) {
    throw new Error(
      `Upstream returned ${
        Array.isArray(embedding) ? embedding.length : "no"
      } dimensions; expected ${dimensions}`
    );
  }

  return embedding;
}

async function embed(text: string): Promise<number[]> {
  const key = keyOf(text);
  const existing = fixture.vectors[key];

  if (existing) {
    return existing;
  }

  if (!record) {
    throw new FixtureMissError(key);
  }

  const vector = await recordVector(text);
  fixture.vectors[key] = vector;
  dirty = true;
  return vector;
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);

  if (request.method === "GET") {
    if (url.pathname === "/" || url.pathname === "/api/tags") {
      sendJson(response, 200, { models: [{ name: model }] });
      return;
    }
    sendJson(response, 404, { error: "not found" });
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }

  void (async () => {
    try {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;

      if (url.pathname === "/api/embed") {
        const input = body.input;
        const texts = Array.isArray(input)
          ? input
          : typeof input === "string"
            ? [input]
            : null;

        if (!texts || texts.some((text) => typeof text !== "string")) {
          sendJson(response, 400, { error: "input must be a string or string[]" });
          return;
        }

        const embeddings: number[][] = [];
        for (const text of texts as string[]) {
          embeddings.push(await embed(text));
        }

        if (dirty) {
          saveFixture();
          dirty = false;
        }

        sendJson(response, 200, { embeddings });
        return;
      }

      if (url.pathname === "/api/embeddings") {
        if (typeof body.prompt !== "string") {
          sendJson(response, 400, { error: "prompt must be a string" });
          return;
        }

        const embedding = await embed(body.prompt);

        if (dirty) {
          saveFixture();
          dirty = false;
        }

        sendJson(response, 200, { embedding });
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof FixtureMissError) {
        console.error(
          `[embedding-stub] fixture miss for ${error.key}. Re-record with --record.`
        );
        sendJson(response, 503, {
          error: "embedding fixture miss",
          key: error.key,
        });
        return;
      }

      console.error("[embedding-stub] request failed", error);
      sendJson(response, 500, { error: "embedding stub failed" });
    }
  })();
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

server.listen(port, "127.0.0.1", () => {
  console.log(
    `[embedding-stub] ${record ? "recording" : "replaying"} ${Object.keys(
      fixture.vectors
    ).length} vector(s) for ${model} (${dimensions}d) on http://127.0.0.1:${port}`
  );
  if (record) {
    console.log(`[embedding-stub] upstream ${upstream}; fixture ${fixturePath}`);
  }
});
