import axios, { AxiosError } from "axios";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmbeddingResult = {
  embedding: number[];
  dimensions: number;
  model: string;
};

type OllamaEmbeddingResponse = {
  embedding: number[];
};

type OllamaBatchEmbeddingResponse = {
  model?: string;
  embeddings: number[][];
};

type OllamaHealthResponse = {
  status?: string;
};

// ---------------------------------------------------------------------------
// Custom Errors
// ---------------------------------------------------------------------------

export class EmbeddingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingValidationError";
  }
}

export class EmbeddingConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingConnectionError";
  }
}

export class EmbeddingModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingModelError";
  }
}

// ---------------------------------------------------------------------------
// Service Functions
// ---------------------------------------------------------------------------

/**
 * Generate an embedding vector for the given text using Ollama.
 *
 * Calls `POST /api/embeddings` on the local Ollama server.
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  if (!text || text.trim().length === 0) {
    throw new EmbeddingValidationError("Text must be a non-empty string");
  }

  const trimmed = text.trim();

  try {
    const response = await axios.post<OllamaEmbeddingResponse>(
      `${OLLAMA_URL}/api/embeddings`,
      {
        model: EMBEDDING_MODEL,
        prompt: trimmed,
      },
      {
        timeout: 60_000, // First call may take longer (Ollama cold-start model loading)
        headers: { "Content-Type": "application/json" },
      }
    );

    const { embedding } = response.data;

    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new EmbeddingModelError(
        "Ollama returned an invalid or empty embedding vector"
      );
    }

    return {
      embedding,
      dimensions: embedding.length,
      model: EMBEDDING_MODEL,
    };
  } catch (error) {
    if (error instanceof EmbeddingValidationError) throw error;
    if (error instanceof EmbeddingModelError) throw error;

    if (error instanceof AxiosError) {
      if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
        throw new EmbeddingConnectionError(
          `Cannot connect to Ollama at ${OLLAMA_URL}. Is Ollama running?`
        );
      }

      if (error.response?.status === 404) {
        throw new EmbeddingModelError(
          `Model '${EMBEDDING_MODEL}' not found. Run: ollama pull ${EMBEDDING_MODEL}`
        );
      }

      throw new EmbeddingConnectionError(
        `Ollama request failed (${error.response?.status ?? "unknown"}): ${error.message}`
      );
    }

    throw error;
  }
}

/**
 * Generate embeddings for multiple texts in one Ollama request.
 *
 * Uses `POST /api/embed`, which accepts an array of inputs. This avoids one
 * HTTP round trip per chunk and lets Ollama schedule the batch together.
 */
export async function generateEmbeddings(
  texts: string[]
): Promise<EmbeddingResult[]> {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new EmbeddingValidationError(
      "Texts must be a non-empty string array"
    );
  }

  const trimmedTexts = texts.map((text, index) => {
    if (!text || text.trim().length === 0) {
      throw new EmbeddingValidationError(
        `Text at index ${index} must be a non-empty string`
      );
    }

    return text.trim();
  });

  try {
    const response = await axios.post<OllamaBatchEmbeddingResponse>(
      `${OLLAMA_URL}/api/embed`,
      {
        model: EMBEDDING_MODEL,
        input: trimmedTexts,
      },
      {
        timeout: 120_000,
        headers: { "Content-Type": "application/json" },
      }
    );

    const { embeddings } = response.data;

    if (!Array.isArray(embeddings) || embeddings.length === 0) {
      throw new EmbeddingModelError(
        "Ollama returned an invalid or empty embeddings array"
      );
    }

    if (embeddings.length !== trimmedTexts.length) {
      throw new EmbeddingModelError(
        `Ollama returned ${embeddings.length} embeddings for ${trimmedTexts.length} inputs`
      );
    }

    return embeddings.map((embedding, index) => {
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new EmbeddingModelError(
          `Ollama returned an invalid embedding at index ${index}`
        );
      }

      return {
        embedding,
        dimensions: embedding.length,
        model: response.data.model || EMBEDDING_MODEL,
      };
    });
  } catch (error) {
    if (error instanceof EmbeddingValidationError) throw error;
    if (error instanceof EmbeddingModelError) throw error;

    if (error instanceof AxiosError) {
      if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
        throw new EmbeddingConnectionError(
          `Cannot connect to Ollama at ${OLLAMA_URL}. Is Ollama running?`
        );
      }

      if (error.response?.status === 404) {
        throw new EmbeddingModelError(
          `Model '${EMBEDDING_MODEL}' not found. Run: ollama pull ${EMBEDDING_MODEL}`
        );
      }

      throw new EmbeddingConnectionError(
        `Ollama batch request failed (${error.response?.status ?? "unknown"}): ${error.message}`
      );
    }

    throw error;
  }
}

/**
 * Check whether Ollama is reachable and the embedding model is available.
 */
export async function checkOllamaHealth(): Promise<{
  healthy: boolean;
  ollamaUrl: string;
  model: string;
  message: string;
}> {
  try {
    await axios.get<OllamaHealthResponse>(OLLAMA_URL, { timeout: 5_000 });

    // Verify the model is available by generating a tiny test embedding
    await axios.post(
      `${OLLAMA_URL}/api/embeddings`,
      { model: EMBEDDING_MODEL, prompt: "health check" },
      { timeout: 120_000 } // Cold start: model may need to load into memory
    );

    return {
      healthy: true,
      ollamaUrl: OLLAMA_URL,
      model: EMBEDDING_MODEL,
      message: "Ollama is running and model is available",
    };
  } catch (error) {
    const reason =
      error instanceof AxiosError
        ? error.code === "ECONNREFUSED"
          ? "Ollama is not running"
          : `Ollama error: ${error.message}`
        : "Unknown error";

    return {
      healthy: false,
      ollamaUrl: OLLAMA_URL,
      model: EMBEDDING_MODEL,
      message: reason,
    };
  }
}
