import axios, { AxiosError } from "axios";

import {
  EmbeddingConfigError,
  EmbeddingConnectionError,
  EmbeddingModelError,
} from "./errors.js";
import type {
  EmbeddingBatch,
  EmbeddingProbe,
  EmbeddingProvider,
  EmbeddingRole,
} from "./provider.js";
import { GEMINI_BASE_URL } from "./settings.js";
import type { EmbeddingSettings } from "./settings.js";

type GeminiBatchResponse = {
  embeddings?: { values?: number[] }[];
};

type GeminiModelsResponse = {
  models?: { name?: string }[];
};

/**
 * Task instructions are the reason this provider is worth adding: nomic has no
 * equivalent, and a document corpus embedded with `RETRIEVAL_DOCUMENT` while
 * queries use `RETRIEVAL_QUERY` matches better than one embedded blindly.
 */
const TASK_TYPES: Record<EmbeddingRole, string> = {
  document: "RETRIEVAL_DOCUMENT",
  query: "RETRIEVAL_QUERY",
};

/**
 * Google documents that a `outputDimensionality` below 3 072 must be
 * L2-normalised by the caller. Cosine distance is magnitude-invariant, so this
 * does not change ranking today; it keeps stored vectors comparable with an
 * inner-product index if one is ever added, and it costs one pass.
 */
function unitLength(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  if (!Number.isFinite(norm) || norm === 0) {
    throw new EmbeddingModelError(
      "The embedding service returned a zero-length vector."
    );
  }

  return vector.map((value) => value / norm);
}

/**
 * The free tier caps `batchEmbedContents` per minute, and a corpus ingestion or
 * an evaluation run can cross that cap in a burst. A 429 is transient, so a
 * bounded wait beats failing a job that is already 90 % done. The cap is small
 * because a daily-quota 429 never clears by waiting and must not stall a
 * request for minutes.
 */
const RATE_LIMIT_BACKOFF_MS = [10_000, 30_000, 60_000];

/**
 * Gemini embeddings (`POST /v1beta/models/{model}:batchEmbedContents`).
 *
 * `gemini-embedding-001` can emit 768 dimensions through `outputDimensionality`,
 * which is the width `source_chunks.embedding` already uses -- so switching to
 * it needs no schema change and no index rebuild.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "gemini" as const;
  readonly model: string;
  readonly dimensions: number;
  readonly endpoint: string;

  constructor(
    private readonly settings: EmbeddingSettings,
    /** Injected by tests so exercising a retry does not sleep. */
    private readonly backoffMs: readonly number[] = RATE_LIMIT_BACKOFF_MS
  ) {
    this.model = settings.model;
    this.dimensions = settings.dimensions;
    // The settings always supply Gemini's host; the fallback only covers a
    // hand-built settings object (tests), never a configured deployment.
    this.endpoint = settings.baseUrl ?? GEMINI_BASE_URL;
  }

  private requireApiKey(): string {
    if (!this.settings.apiKey) {
      throw new EmbeddingConfigError(
        "GEMINI_API_KEY (or EMBEDDING_API_KEY) is required when EMBEDDING_PROVIDER=gemini."
      );
    }

    return this.settings.apiKey;
  }

  /**
   * One batch call, retried while the API answers 429 and the backoff list has
   * an entry left. Any other failure, or a 429 with no backoff left, is thrown
   * to `embed` so it is mapped to the same explicit error as before.
   */
  private async postBatch(
    body: unknown,
    apiKey: string
  ): Promise<GeminiBatchResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await axios.post<GeminiBatchResponse>(
          `${this.endpoint}/v1beta/models/${this.model}:batchEmbedContents`,
          body,
          {
            timeout: 120_000,
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
            },
          }
        );
        return response.data;
      } catch (error) {
        const delay = this.backoffMs[attempt];
        const limited =
          error instanceof AxiosError && error.response?.status === 429;

        if (!limited || delay === undefined) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async embed(
    texts: string[],
    role: EmbeddingRole = "document"
  ): Promise<EmbeddingBatch> {
    const apiKey = this.requireApiKey();

    try {
      const { embeddings: rows } = await this.postBatch(
        {
          requests: texts.map((text) => ({
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
            taskType: TASK_TYPES[role],
            outputDimensionality: this.dimensions,
          })),
        },
        apiKey
      );

      if (!Array.isArray(rows) || rows.length === 0) {
        throw new EmbeddingModelError(
          "The embedding service returned no vectors for this request."
        );
      }

      if (rows.length !== texts.length) {
        throw new EmbeddingModelError(
          `The embedding service returned ${rows.length} vectors for ${texts.length} inputs.`
        );
      }

      // `batchEmbedContents` answers in request order; assert the shape rather
      // than trusting it, because a mis-paired vector poisons the index silently.
      const embeddings = rows.map((row, index) => {
        if (!Array.isArray(row.values) || row.values.length === 0) {
          throw new EmbeddingModelError(
            `The embedding service returned an empty vector at index ${index}.`
          );
        }

        return unitLength(row.values);
      });

      return { embeddings, model: this.model };
    } catch (error) {
      if (
        error instanceof EmbeddingModelError ||
        error instanceof EmbeddingConfigError
      ) {
        throw error;
      }

      if (error instanceof AxiosError) {
        if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
          throw new EmbeddingConnectionError(
            `Cannot connect to the embedding service at ${this.endpoint}.`
          );
        }

        if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
          throw new EmbeddingConnectionError(
            `The embedding service at ${this.endpoint} did not answer in time.`
          );
        }

        const status = error.response?.status;

        if (status === 401 || status === 403) {
          throw new EmbeddingModelError(
            `The embedding service rejected the credentials (${status}). Check GEMINI_API_KEY.`
          );
        }

        if (status === 429) {
          throw new EmbeddingConnectionError(
            "The embedding service is rate limiting this deployment (429). Retry later or lower INGESTION_CONCURRENCY."
          );
        }

        if (status === 404) {
          throw new EmbeddingModelError(
            `Model '${this.model}' is not available for embedding.`
          );
        }

        const detail =
          (error.response?.data as { error?: { message?: string } } | undefined)
            ?.error?.message ?? error.message;

        throw new EmbeddingConnectionError(
          `Embedding request failed (${status ?? "no response"}): ${detail}`
        );
      }

      throw error;
    }
  }

  /**
   * Lists models rather than embedding a probe string: `/ai/health` is polled on
   * every page load, and listing is not billed as an embedding request.
   */
  async probe(): Promise<EmbeddingProbe> {
    let apiKey: string;

    try {
      apiKey = this.requireApiKey();
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "Embedding service is not configured",
      };
    }

    try {
      const response = await axios.get<GeminiModelsResponse>(
        `${this.endpoint}/v1beta/models`,
        {
          timeout: 5_000,
          params: { pageSize: 1_000 },
          headers: { "x-goog-api-key": apiKey },
        }
      );

      const ids = (response.data.models ?? [])
        .map((entry) => entry.name?.replace(/^models\//, ""))
        .filter((id): id is string => typeof id === "string" && id.length > 0);

      if (ids.length > 0 && !ids.includes(this.model)) {
        return {
          ok: false,
          message: `The embedding service does not list model '${this.model}'. Available: ${ids
            .filter((id) => id.includes("embedding"))
            .slice(0, 8)
            .join(", ")}`,
        };
      }

      return {
        ok: true,
        message:
          ids.length === 0
            ? "The embedding service answered; it did not list its models"
            : "The embedding service answered and lists the model",
      };
    } catch (error) {
      const reason =
        error instanceof AxiosError
          ? error.code === "ECONNREFUSED"
            ? `Cannot connect to ${this.endpoint}`
            : `Embedding service error: ${error.message}`
          : "Unknown error";

      return { ok: false, message: reason };
    }
  }
}
