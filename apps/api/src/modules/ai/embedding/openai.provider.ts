import axios, { AxiosError } from "axios";

import {
  EmbeddingConfigError,
  EmbeddingConnectionError,
  EmbeddingModelError,
} from "./errors.js";
import type { EmbeddingBatch, EmbeddingProbe, EmbeddingProvider } from "./provider.js";
import type { EmbeddingSettings } from "./settings.js";

type OpenAiEmbeddingResponse = {
  model?: string;
  data?: { embedding?: number[]; index?: number }[];
};

type OpenAiModelsResponse = {
  data?: { id?: string }[];
};

/**
 * Any service that implements the OpenAI embeddings API:
 *
 *   POST {EMBEDDING_BASE_URL}/embeddings
 *   { "model": "...", "input": ["...", "..."] }
 *   Authorization: Bearer {EMBEDDING_API_KEY}
 *
 * This is what makes ingestion and search work on a host that cannot run
 * Ollama. It is deliberately unopinionated about the vendor: a hosted API, a
 * local llama.cpp server and a gateway all speak this shape.
 *
 * The vector width the database accepts is fixed (see settings.ts), so a model
 * that cannot produce 768 dimensions is not usable here. `EMBEDDING_SEND_DIMENSIONS`
 * passes `dimensions` to models that support truncated output (the
 * `text-embedding-3-*` family); other services reject the extra field, so it is
 * opt-in.
 */
export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai-compatible" as const;
  readonly model: string;
  readonly dimensions: number;
  readonly endpoint: string;

  constructor(private readonly settings: EmbeddingSettings) {
    this.model = settings.model;
    this.dimensions = settings.dimensions;
    this.endpoint = settings.baseUrl ?? "(EMBEDDING_BASE_URL is not set)";
  }

  private requireBaseUrl(): string {
    if (!this.settings.baseUrl) {
      throw new EmbeddingConfigError(
        "EMBEDDING_BASE_URL is required when EMBEDDING_PROVIDER=openai-compatible " +
          "(for example https://api.example.com/v1)."
      );
    }

    return this.settings.baseUrl;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    // A local server often needs no key; a hosted one always does.
    if (this.settings.apiKey) {
      headers.Authorization = `Bearer ${this.settings.apiKey}`;
    }

    return headers;
  }

  async embed(texts: string[]): Promise<EmbeddingBatch> {
    const baseUrl = this.requireBaseUrl();

    try {
      const response = await axios.post<OpenAiEmbeddingResponse>(
        `${baseUrl}/embeddings`,
        {
          model: this.model,
          input: texts,
          ...(this.settings.sendDimensions ? { dimensions: this.dimensions } : {}),
        },
        { timeout: 120_000, headers: this.headers() }
      );

      const rows = response.data.data;

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

      // The API guarantees an `index` but not the order of the array; pairing a
      // vector with the wrong text would poison the index silently.
      const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

      const embeddings = ordered.map((row) => {
        if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
          throw new EmbeddingModelError(
            "The embedding service returned an empty vector."
          );
        }
        return row.embedding;
      });

      return { embeddings, model: response.data.model || this.model };
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
            `Cannot connect to the embedding service at ${baseUrl}.`
          );
        }

        if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
          throw new EmbeddingConnectionError(
            `The embedding service at ${baseUrl} did not answer in time.`
          );
        }

        const status = error.response?.status;

        if (status === 401 || status === 403) {
          throw new EmbeddingModelError(
            `The embedding service rejected the credentials (${status}). Check EMBEDDING_API_KEY.`
          );
        }

        if (status === 429) {
          throw new EmbeddingConnectionError(
            "The embedding service is rate limiting this deployment (429). Retry later or lower INGESTION_CONCURRENCY."
          );
        }

        const detail =
          (error.response?.data as { error?: { message?: string } } | undefined)?.error
            ?.message ?? error.message;

        throw new EmbeddingConnectionError(
          `Embedding request failed (${status ?? "no response"}): ${detail}`
        );
      }

      throw error;
    }
  }

  /**
   * Lists models rather than embedding a probe string: `/ai/health` is polled by
   * the shell on every page load, and a probe embedding would spend quota on
   * each one.
   */
  async probe(): Promise<EmbeddingProbe> {
    let baseUrl: string;

    try {
      baseUrl = this.requireBaseUrl();
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Embedding service is not configured",
      };
    }

    try {
      const response = await axios.get<OpenAiModelsResponse>(`${baseUrl}/models`, {
        timeout: 5_000,
        headers: this.headers(),
      });

      const ids = (response.data.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === "string");

      if (ids.length === 0) {
        return {
          ok: true,
          message: "The embedding service answered; it did not list its models",
        };
      }

      if (!ids.includes(this.model)) {
        return {
          ok: false,
          message: `The embedding service does not list model '${this.model}'. Available: ${ids
            .slice(0, 8)
            .join(", ")}`,
        };
      }

      return { ok: true, message: "The embedding service answered and lists the model" };
    } catch (error) {
      const reason =
        error instanceof AxiosError
          ? error.code === "ECONNREFUSED"
            ? `Cannot connect to ${baseUrl}`
            : `Embedding service error: ${error.message}`
          : "Unknown error";

      return { ok: false, message: reason };
    }
  }
}
