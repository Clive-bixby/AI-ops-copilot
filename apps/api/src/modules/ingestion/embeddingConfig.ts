import { createHash } from "node:crypto";

/**
 * Embedding configuration identity.
 *
 * A stored vector is only comparable with a query vector produced by the same
 * model and width. Recording both at write time (source_chunks.embedding_model,
 * source_chunks.embedding_dimensions) lets ingestion skip work that is already
 * current and lets retrieval reject a configuration mismatch instead of
 * returning meaningless neighbours.
 */

const DEFAULT_MODEL = "nomic-embed-text";
const DEFAULT_DIMENSIONS = 768;

export type EmbeddingConfig = {
  model: string;
  dimensions: number;
  /** Stable fingerprint of model + width, stored on jobs and used for reuse decisions. */
  hash: string;
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function getEmbeddingConfig(): EmbeddingConfig {
  const model = (process.env.OLLAMA_EMBEDDING_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const dimensions = parsePositiveInt(
    process.env.EMBEDDING_DIMENSIONS,
    DEFAULT_DIMENSIONS
  );

  return {
    model,
    dimensions,
    hash: createHash("sha256").update(`${model}:${dimensions}`).digest("hex"),
  };
}

export function assertEmbeddingMatchesConfig(
  embedding: number[],
  config: EmbeddingConfig,
  label: string
): void {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error(`${label} must be a non-empty number array`);
  }

  if (embedding.length !== config.dimensions) {
    throw new Error(
      `${label} has ${embedding.length} dimensions; model '${config.model}' is configured for ${config.dimensions}. ` +
        "Re-index the source after changing OLLAMA_EMBEDDING_MODEL or EMBEDDING_DIMENSIONS."
    );
  }
}

/**
 * Hash of normalised text. Used as both `documents.content_hash` and chunk
 * fingerprints so a re-upload of identical text can be detected before any
 * embedding request is made.
 */
export function hashContent(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

export function hashFileBytes(bytes: Buffer): string {
  return createHash("md5").update(bytes).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b)
    );

    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

/**
 * Canonical fingerprint of a log event. Two identical submissions of the same
 * event produce the same hash; the partial unique index on
 * (organization_id, content_hash) then makes the second insert a no-op.
 */
export function hashLogEvent(input: {
  level: string;
  message: string;
  timestamp: Date | string;
  metadata: Record<string, unknown> | null;
}): string {
  const timestamp =
    input.timestamp instanceof Date
      ? input.timestamp.toISOString()
      : new Date(input.timestamp).toISOString();

  return hashContent(
    `${input.level}|${input.message}|${timestamp}|${stableJson(input.metadata ?? {})}`
  );
}
