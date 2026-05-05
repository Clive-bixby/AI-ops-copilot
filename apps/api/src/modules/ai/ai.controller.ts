import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import { createDocument } from "../documents/documents.service.js";
import { checkOllamaHealth, generateEmbedding } from "./embedding.service.js";
import { chunkText, cleanText, estimateTokens } from "./chunk.service.js";
import type { ChunkOptions } from "./chunk.service.js";
import { insertChunks, searchSimilar } from "./vector.service.js";

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

/**
 * POST /ai/test-index
 *
 * Temporary protected endpoint for seeding document chunks into pgvector.
 */
export const testIndexController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const { text, filename, maxTokens, overlap, minTokens } = req.body as {
    text?: string;
    filename?: string;
    maxTokens?: number;
    overlap?: number;
    minTokens?: number;
  };

  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    throw createHttpError(400, "Request body must include a non-empty 'text' field");
  }

  const options: ChunkOptions = {};
  if (typeof maxTokens === "number") options.maxTokens = maxTokens;
  if (typeof overlap === "number") options.overlap = overlap;
  options.minTokens = typeof minTokens === "number" ? minTokens : 5;

  const chunks = chunkText(text, options);
  if (chunks.length === 0) {
    throw createHttpError(400, "Text did not produce any chunks");
  }

  const document = await createDocument({
    organizationId,
    filename:
      typeof filename === "string" && filename.trim()
        ? filename.trim()
        : "day-3-test-document.txt",
    content: text,
  });

  const embeddingResults = await Promise.all(
    chunks.map((chunk) => generateEmbedding(chunk.content))
  );

  const storedChunks = await insertChunks(
    chunks.map((chunk) => ({
      content: chunk.content,
      index: chunk.index,
      metadata: {
        sourceType: "document",
        sourceId: document.id,
        chunkHash: chunk.hash,
        tokenCount: chunk.tokenCount,
        charCount: chunk.charCount,
      },
    })),
    embeddingResults.map((result) => result.embedding),
    document.id,
    organizationId
  );

  return res.status(201).json({
    success: true,
    document,
    model: embeddingResults[0]?.model,
    dimensions: embeddingResults[0]?.dimensions,
    totalChunks: storedChunks.length,
    chunks: storedChunks.map((chunk) => ({
      id: chunk.id,
      chunkIndex: chunk.chunkIndex,
      preview:
        chunk.content.length > 120
          ? chunk.content.slice(0, 120) + "..."
          : chunk.content,
    })),
  });
});

/**
 * POST /ai/test-search
 *
 * Temporary protected endpoint for verifying query embedding + pgvector search.
 */
export const testSearchController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const { query, limit } = req.body as { query?: string; limit?: number };

  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    throw createHttpError(400, "Request body must include a non-empty 'query' field");
  }

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw createHttpError(400, "'limit' must be a positive integer");
  }

  const embeddingResult = await generateEmbedding(query);
  const results = await searchSimilar(
    embeddingResult.embedding,
    organizationId,
    limit
  );

  return res.status(200).json({
    results: results.map((result) => ({
      id: result.id,
      documentId: result.documentId,
      chunkIndex: result.chunkIndex,
      content: result.content,
      metadata: result.metadata,
      distance: result.distance,
      score: result.score,
      createdAt: result.createdAt,
    })),
  });
});
