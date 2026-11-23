import { createServer } from "node:http";

/**
 * Deterministic embeddings for the end-to-end check.
 *
 * The E2E uploads a file the fixture provider has never seen, so it needs a
 * backend that can embed arbitrary text without a model download and without a
 * paid key. This stub speaks the OpenAI embeddings API that
 * `EMBEDDING_PROVIDER=openai-compatible` already targets.
 *
 * Every input maps to the same unit vector, so cosine similarity is exactly 1.0
 * and the retrieval similarity floor always passes. That is deliberate: the
 * check measures the pipeline -- parse, chunk, embed, store in pgvector, rank,
 * return -- and not embedding quality, which the recording-based evaluation
 * covers. A model that actually separates texts would only add a fetch to the
 * check.
 */

const PORT = Number(process.env.PORT ?? 8080);
const MODEL = process.env.EMBEDDING_STUB_MODEL ?? "e2e-stub";
const DIMENSIONS = 768;

const VECTOR = new Array(DIMENSIONS).fill(1 / Math.sqrt(DIMENSIONS));

function send(res, status, body) {
  const payload = JSON.stringify(body);

  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { status: "ok", model: MODEL, dimensions: DIMENSIONS });
  }

  // The provider probes the model list before ingestion, so a stub that only
  // served /embeddings would report the whole pipeline unhealthy.
  if (req.method === "GET" && url.pathname === "/v1/models") {
    return send(res, 200, { object: "list", data: [{ id: MODEL, object: "model" }] });
  }

  if (req.method !== "POST" || url.pathname !== "/v1/embeddings") {
    return send(res, 404, { error: "not found" });
  }

  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    let input;
    try {
      ({ input } = JSON.parse(raw));
    } catch {
      return send(res, 400, { error: "request body must be JSON" });
    }

    const texts = Array.isArray(input) ? input : [input];

    if (texts.length === 0) {
      return send(res, 400, { error: "input must not be empty" });
    }

    return send(res, 200, {
      object: "list",
      model: MODEL,
      data: texts.map((_text, index) => ({
        object: "embedding",
        index,
        embedding: VECTOR,
      })),
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[embedding-stub] listening on ${PORT} (${DIMENSIONS}d, ${MODEL})`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
