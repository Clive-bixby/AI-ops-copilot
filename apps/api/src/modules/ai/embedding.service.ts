import { getEmbeddingProvider } from "./embedding/index.js";
import {
  EmbeddingConfigError,
  EmbeddingModelError,
  EmbeddingValidationError,
} from "./embedding/errors.js";

export {
  EmbeddingConfigError,
  EmbeddingConnectionError,
  EmbeddingModelError,
  EmbeddingValidationError,
} from "./embedding/errors.js";

/**
 * Embedding facade.
 *
 * Every caller -- ingestion, retrieval, the health endpoint, the evaluations --
 * keeps the same functions as before; the provider behind them is chosen by
 * `EMBEDDING_PROVIDER` (see `./embedding/index.ts`). Providers differ in
 * protocol only, so the width and count checks live here once instead of in
 * each backend.
 */

export type EmbeddingResult = {
  embedding: number[];
  dimensions: number;
  model: string;
};

export type EmbeddingHealth = {
  healthy: boolean;
  /** "ollama" | "openai-compatible" | "fixture" */
  provider: string;
  model: string;
  /** null when the configuration is too broken to know the width. */
  dimensions: number | null;
  /** Base URL of the service, or the fixture file path. */
  endpoint: string;
  message: string;
};

function normaliseTexts(texts: string[]): string[] {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new EmbeddingValidationError("Texts must be a non-empty string array");
  }

  return texts.map((text, index) => {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new EmbeddingValidationError(
        `Text at index ${index} must be a non-empty string`
      );
    }

    return text.trim();
  });
}

/**
 * A vector whose width differs from the configured model is unusable: the
 * column is `VECTOR(768)` and retrieval compares widths before it compares
 * distances. Reporting the mismatch here names the cause instead of letting a
 * driver error surface later.
 */
function toResults(
  embeddings: number[][],
  model: string,
  expectedDimensions: number
): EmbeddingResult[] {
  return embeddings.map((embedding, index) => {
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new EmbeddingModelError(
        `The embedding service returned an invalid vector at index ${index}.`
      );
    }

    if (embedding.length !== expectedDimensions) {
      throw new EmbeddingModelError(
        `The embedding service returned a ${embedding.length}-dimension vector but ` +
          `${expectedDimensions} is configured. EMBEDDING_DIMENSIONS must match the ` +
          "stored vector width, which the schema fixes at 768."
      );
    }

    return { embedding, dimensions: embedding.length, model };
  });
}

/** Generate an embedding vector for one piece of text. */
export async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  const [result] = await generateEmbeddings([text]);

  if (!result) {
    throw new EmbeddingModelError("The embedding service returned no vector.");
  }

  return result;
}

/** Generate embeddings for several texts in one provider request. */
export async function generateEmbeddings(
  texts: string[]
): Promise<EmbeddingResult[]> {
  const trimmed = normaliseTexts(texts);
  const provider = getEmbeddingProvider();
  const batch = await provider.embed(trimmed);

  return toResults(
    batch.embeddings,
    batch.model || provider.model,
    provider.dimensions
  );
}

/**
 * Report which provider is in use and whether it can answer.
 *
 * The payload names the provider and its endpoint because the answer used to be
 * reported as `ollamaUrl` unconditionally, which is wrong the moment embeddings
 * come from somewhere else.
 */
export async function checkEmbeddingHealth(): Promise<EmbeddingHealth> {
  try {
    const provider = getEmbeddingProvider();
    const probe = await provider.probe();

    return {
      healthy: probe.ok,
      provider: provider.name,
      model: provider.model,
      dimensions: provider.dimensions,
      endpoint: provider.endpoint,
      message: probe.message,
    };
  } catch (error) {
    // A misconfiguration (an unknown EMBEDDING_PROVIDER, a bad width) is the
    // single most likely reason someone opens this endpoint. Reporting it as a
    // generic 500 would hide the exact sentence they need, and the message names
    // only environment variables -- never a secret.
    if (error instanceof EmbeddingConfigError) {
      return {
        healthy: false,
        provider: process.env.EMBEDDING_PROVIDER?.trim() || "unconfigured",
        model:
          process.env.EMBEDDING_MODEL?.trim() ||
          process.env.OLLAMA_EMBEDDING_MODEL?.trim() ||
          "unconfigured",
        dimensions: null,
        endpoint: "not configured",
        message: error.message,
      };
    }

    throw error;
  }
}
