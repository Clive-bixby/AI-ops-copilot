import { generateEmbeddings } from "../ai/embedding.service.js";
import type { EmbeddingResult } from "../ai/embedding.service.js";

/**
 * Ollama accepts a batch of inputs, but a single request for hundreds of chunks
 * is slow to time out and hard to retry. Batching bounds each request and keeps
 * one failed batch from discarding every embedding already produced.
 */
const EMBEDDING_BATCH_SIZE = 16;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function embedTexts(texts: string[]): Promise<EmbeddingResult[]> {
  const results: EmbeddingResult[] = [];

  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        results.push(...(await generateEmbeddings(batch)));
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;

        if (attempt < MAX_ATTEMPTS) {
          await wait(RETRY_DELAY_MS);
        }
      }
    }

    if (lastError !== undefined) {
      throw lastError;
    }
  }

  return results;
}
