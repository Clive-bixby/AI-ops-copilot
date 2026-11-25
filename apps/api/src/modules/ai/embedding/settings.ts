import "../../../config/env.js";

import path from "node:path";
import { fileURLToPath } from "node:url";

import { EmbeddingConfigError } from "./errors.js";

/**
 * Configuration for the embedding provider.
 *
 * Embeddings decide whether retrieval works at all, and they used to be
 * hard-wired to a local Ollama server. That is the one dependency a free host
 * cannot satisfy, so the provider is now a choice instead of an assumption.
 *
 * Settings are read on demand rather than at import time so a misconfiguration
 * surfaces as an explicit error on first use (`/ai/health`, ingestion) instead of
 * preventing the process from starting.
 */

export type ProviderName = "ollama" | "openai-compatible" | "gemini" | "fixture";

/**
 * The stored vector width, fixed by `document_chunks.embedding VECTOR(768)` in
 * 0001, inherited by `source_chunks` in 0003. `EMBEDDING_DIMENSIONS` may only
 * differ from this with a migration that changes the column type.
 */
export const SCHEMA_EMBEDDING_DIMENSIONS = 768;

const PROVIDER_ALIASES: Record<string, ProviderName> = {
  ollama: "ollama",
  openai: "openai-compatible",
  "openai-compatible": "openai-compatible",
  gemini: "gemini",
  fixture: "fixture",
};

/** Gemini serves embeddings from the same host as generation, under /v1beta. */
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";

export type EmbeddingSettings = {
  provider: ProviderName;
  model: string;
  dimensions: number;
  /** Ollama's base URL. Unused by the other providers. */
  ollamaUrl: string;
  /** Base URL of an OpenAI-compatible API; null when not configured. */
  baseUrl: string | null;
  /** Bearer token for that API; null for a server that needs none. */
  apiKey: string | null;
  /** Send `dimensions` with the request (supported by some models only). */
  sendDimensions: boolean;
  /** Absolute path to the recorded-vector file used by fixture mode. */
  fixturePath: string;
};

function trimmed(value: string | undefined): string | null {
  const result = value?.trim();
  return result ? result : null;
}

function parseDimensions(): number {
  const raw = trimmed(process.env.EMBEDDING_DIMENSIONS);

  if (raw === null) {
    return SCHEMA_EMBEDDING_DIMENSIONS;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new EmbeddingConfigError(
      `EMBEDDING_DIMENSIONS must be a positive integer (received "${raw}").`
    );
  }

  return parsed;
}

function parseProvider(): ProviderName {
  // `?.` on a `string | null` yields `string | undefined`, hence the falsy guard.
  const raw = trimmed(process.env.EMBEDDING_PROVIDER)?.toLowerCase();

  if (!raw) {
    return "ollama";
  }

  const provider = PROVIDER_ALIASES[raw];

  if (!provider) {
    throw new EmbeddingConfigError(
      `Unknown EMBEDDING_PROVIDER "${raw}". Use one of: ${Object.keys(
        PROVIDER_ALIASES
      ).join(", ")}.`
    );
  }

  return provider;
}

export function readEmbeddingSettings(): EmbeddingSettings {
  const provider = parseProvider();
  const configuredFixturePath = trimmed(process.env.EMBEDDING_FIXTURE_PATH);
  const configuredModel =
    trimmed(process.env.EMBEDDING_MODEL) ??
    trimmed(process.env.OLLAMA_EMBEDDING_MODEL);
  // A provider's own default, not another provider's: inheriting
  // "nomic-embed-text" would send a model name Gemini does not have.
  const model =
    configuredModel ??
    (provider === "gemini" ? GEMINI_EMBEDDING_MODEL : "nomic-embed-text");
  const explicitKey = trimmed(process.env.EMBEDDING_API_KEY);

  return {
    provider,
    model,
    dimensions: parseDimensions(),
    ollamaUrl: (trimmed(process.env.OLLAMA_URL) ?? "http://localhost:11434").replace(
      /\/+$/,
      ""
    ),
    baseUrl:
      trimmed(process.env.EMBEDDING_BASE_URL)?.replace(/\/+$/, "") ??
      (provider === "gemini" ? GEMINI_BASE_URL : null),
    // One key for both features unless a separate embedding key is set.
    apiKey:
      explicitKey ??
      (provider === "gemini" ? trimmed(process.env.GEMINI_API_KEY) : null),
    sendDimensions:
      (trimmed(process.env.EMBEDDING_SEND_DIMENSIONS) ?? "false").toLowerCase() ===
      "true",
    // The default resolves relative to this file so it works from any working
    // directory, including inside the container. An override is resolved against
    // the current directory, which is what a shell user expects.
    fixturePath: configuredFixturePath
      ? path.resolve(configuredFixturePath)
      : fileURLToPath(new URL("../../../evaluation/embeddingFixtures.json", import.meta.url)),
  };
}
