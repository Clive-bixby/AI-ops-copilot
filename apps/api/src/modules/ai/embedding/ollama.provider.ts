import axios, { AxiosError } from "axios";

import {
  EmbeddingConnectionError,
  EmbeddingModelError,
} from "./errors.js";
import type { EmbeddingBatch, EmbeddingProbe, EmbeddingProvider } from "./provider.js";
import type { EmbeddingSettings } from "./settings.js";

type OllamaEmbedResponse = {
  model?: string;
  embeddings?: number[][];
};

type OllamaTagsResponse = {
  models?: { name?: string; model?: string }[];
};

/**
 * Local Ollama (`nomic-embed-text` by default) -- the development default.
 *
 * A batch request is used for both single and multiple texts: `/api/embed`
 * accepts a string or an array, so there is one code path to reason about
 * instead of a separate `/api/embeddings` call for one text.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama" as const;
  readonly model: string;
  readonly dimensions: number;
  readonly endpoint: string;

  constructor(private readonly settings: EmbeddingSettings) {
    this.model = settings.model;
    this.dimensions = settings.dimensions;
    this.endpoint = settings.ollamaUrl;
  }

  async embed(texts: string[]): Promise<EmbeddingBatch> {
    try {
      const response = await axios.post<OllamaEmbedResponse>(
        `${this.endpoint}/api/embed`,
        { model: this.model, input: texts },
        {
          // A cold model load on a laptop can take a while; a warm batch does not.
          timeout: 120_000,
          headers: { "Content-Type": "application/json" },
        }
      );

      const embeddings = response.data.embeddings;

      if (!Array.isArray(embeddings) || embeddings.length === 0) {
        throw new EmbeddingModelError(
          "The embedding service returned no vectors for this request."
        );
      }

      if (embeddings.length !== texts.length) {
        throw new EmbeddingModelError(
          `The embedding service returned ${embeddings.length} vectors for ${texts.length} inputs.`
        );
      }

      return { embeddings, model: response.data.model || this.model };
    } catch (error) {
      if (error instanceof EmbeddingModelError) throw error;

      if (error instanceof AxiosError) {
        if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
          throw new EmbeddingConnectionError(
            `Cannot connect to the embedding service at ${this.endpoint}. Is Ollama running?`
          );
        }

        if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
          throw new EmbeddingConnectionError(
            `The embedding service at ${this.endpoint} did not answer in time.`
          );
        }

        if (error.response?.status === 404) {
          throw new EmbeddingModelError(
            `Model '${this.model}' is not available at ${this.endpoint}. Run: ollama pull ${this.model}`
          );
        }

        throw new EmbeddingConnectionError(
          `Embedding request failed (${error.response?.status ?? "no response"}): ${error.message}`
        );
      }

      throw error;
    }
  }

  /** Confirms the server answers and the configured model is installed. */
  async probe(): Promise<EmbeddingProbe> {
    try {
      await axios.get(`${this.endpoint}`, { timeout: 5_000 });

      const tags = await axios.get<OllamaTagsResponse>(`${this.endpoint}/api/tags`, {
        timeout: 5_000,
      });

      const installed = (tags.data.models ?? []).some((entry) => {
        const name = entry.name ?? entry.model ?? "";
        return name === this.model || name.startsWith(`${this.model}:`);
      });

      if (!installed) {
        return {
          ok: false,
          message: `Model '${this.model}' is not installed. Run: ollama pull ${this.model}`,
        };
      }

      return { ok: true, message: "Ollama is running and the model is available" };
    } catch (error) {
      const reason =
        error instanceof AxiosError
          ? error.code === "ECONNREFUSED"
            ? "Ollama is not running"
            : `Ollama error: ${error.message}`
          : "Unknown error";

      return { ok: false, message: reason };
    }
  }
}
