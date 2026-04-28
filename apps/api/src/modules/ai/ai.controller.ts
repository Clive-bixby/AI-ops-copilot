import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import { checkOllamaHealth, generateEmbedding } from "./embedding.service.js";
import { chunkText, cleanText, estimateTokens } from "./chunk.service.js";
import type { ChunkOptions } from "./chunk.service.js";

/**
 * POST /ai/test-embedding
 *
 * Temporary test route for verifying that Ollama embeddings work end-to-end.
 */
export const testEmbeddingController = asyncHandler(async (req, res) => {
  const { text } = req.body as { text?: string };

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    throw createHttpError(400, "Request body must include a non-empty 'text' field");
  }

  const result = await generateEmbedding(text);

  return res.status(200).json({
    success: true,
    model: result.model,
    dimensions: result.dimensions,
    preview: result.embedding.slice(0, 5),
  });
});

/**
 * GET /ai/health
 *
 * Check whether Ollama is reachable and the embedding model is loaded.
 */
export const aiHealthController = asyncHandler(async (_req, res) => {
  const health = await checkOllamaHealth();

  const status = health.healthy ? 200 : 503;

  return res.status(status).json(health);
});

/**
 * POST /ai/test-chunk
 *
 * Test endpoint for the chunking engine.
 * Accepts raw text and returns the chunked output with metadata.
 *
 * Body:
 *   - text (required): The document text to chunk
 *   - maxTokens (optional): Target max tokens per chunk (default: 400)
 *   - overlap (optional): Overlap tokens between chunks (default: 75)
 *   - minTokens (optional): Minimum tokens to keep a chunk (default: 50)
 */
export const testChunkController = asyncHandler(async (req, res) => {
  const { text, maxTokens, overlap, minTokens } = req.body as {
    text?: string;
    maxTokens?: number;
    overlap?: number;
    minTokens?: number;
  };

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    throw createHttpError(400, "Request body must include a non-empty 'text' field");
  }

  const options: ChunkOptions = {};
  if (typeof maxTokens === "number") options.maxTokens = maxTokens;
  if (typeof overlap === "number") options.overlap = overlap;
  if (typeof minTokens === "number") options.minTokens = minTokens;

  const chunks = chunkText(text, options);

  const cleanedText = cleanText(text);
  const totalInputTokens = estimateTokens(cleanedText);

  return res.status(200).json({
    success: true,
    totalChunks: chunks.length,
    inputStats: {
      originalLength: text.length,
      cleanedLength: cleanedText.length,
      estimatedInputTokens: totalInputTokens,
    },
    options: {
      maxTokens: options.maxTokens ?? 400,
      overlap: options.overlap ?? 75,
      minTokens: options.minTokens ?? 50,
    },
    chunks: chunks.map((chunk) => ({
      index: chunk.index,
      tokenCount: chunk.tokenCount,
      charCount: chunk.charCount,
      hash: chunk.hash,
      preview: chunk.content.length > 120
        ? chunk.content.slice(0, 120) + "..."
        : chunk.content,
    })),
  });
});
