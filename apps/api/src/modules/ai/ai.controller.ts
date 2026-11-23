import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import { createDocument } from "../documents/documents.service.js";
import { checkEmbeddingHealth, generateEmbedding } from "./embedding.service.js";
import { chunkText, cleanText, estimateTokens } from "./chunk.service.js";
import type { ChunkOptions } from "./chunk.service.js";
import { searchSimilar } from "./vector.service.js";
import { getEmbeddingConfig, hashContent } from "../ingestion/embeddingConfig.js";
import { replaceSourceIndex } from "../ingestion/sourceIndex.service.js";
import {
  searchRelevantChunks,
  validateRetrievalLimit,
  validateRetrievalMode,
  validateSearchQuery,
  validateSourceTypes,
} from "./retrieval.service.js";
import { answerQuestion, validateRAGQuestion } from "./rag.service.js";

/**
 * POST /ai/test-embedding
 *
 * Temporary test route for verifying that the configured embedding provider
 * works end-to-end.
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
 * Report the configured provider and whether it can answer: Ollama reachable
 * with the model installed, an OpenAI-compatible API listing the model, or a
 * fixture file holding vectors.
 */
export const aiHealthController = asyncHandler(async (_req, res) => {
  const health = await checkEmbeddingHealth();

  const status = health.healthy ? 200 : 503;

  return res.status(status).json(health);
});

/**
 * POST /ai/search
 *
 * Production semantic search endpoint. Generates an embedding for a natural
 * language query and returns tenant-scoped, threshold-filtered document chunks.
 */
export const searchController = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const organizationId = req.organizationId;
  const { query, limit, sourceTypes, mode } = req.body as {
    query?: unknown;
    limit?: unknown;
    sourceTypes?: unknown;
    mode?: unknown;
  };

  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const trimmedQuery = validateSearchQuery(query);
  const searchLimit = validateRetrievalLimit(limit);
  const retrievalMode = validateRetrievalMode(mode);
  const sourceTypeFilter = validateSourceTypes(sourceTypes);

  const results = await searchRelevantChunks(
    trimmedQuery,
    organizationId,
    searchLimit,
    {
      mode: retrievalMode,
      ...(sourceTypeFilter ? { sourceTypes: sourceTypeFilter } : {}),
    }
  );

  return res.status(200).json({
    query: trimmedQuery,
    totalResults: results.length,
    executionTimeMs: Date.now() - startedAt,
    results,
  });
});

/**
 * POST /ai/ask
 *
 * Tenant-scoped RAG question answering endpoint. Retrieves relevant chunks,
 * builds a grounded prompt, calls the configured LLM, and returns citations.
 */
export const askQuestion = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const organizationId = req.organizationId;
  const { question } = req.body as { question?: unknown };

  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const trimmedQuestion = validateRAGQuestion(question);

  console.log("Ask question request received", {
    organizationId,
    questionLength: trimmedQuestion.length,
  });

  const result = await answerQuestion(trimmedQuestion, organizationId);

  console.log("Ask question request completed", {
    organizationId,
    executionTimeMs: Date.now() - startedAt,
  });

  return res.status(200).json({
    question: trimmedQuestion,
    answer: result.answer,
    confidence: result.confidence,
    sources: result.sources,
    sourceCount: result.sourceCount,
    metrics: result.metrics,
  });
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

  const storedCount = await replaceSourceIndex({
    organizationId,
    sourceType: "document",
    sourceId: document.id,
    sourceCreatedAt: document.createdAt,
    chunks: chunks.map((chunk) => ({
      index: chunk.index,
      content: chunk.content,
      chunkHash: hashContent(chunk.content),
      metadata: {
        sourceType: "document",
        sourceId: document.id,
        tokenCount: chunk.tokenCount,
        charCount: chunk.charCount,
      },
    })),
    embeddings: embeddingResults.map((result) => result.embedding),
    config: getEmbeddingConfig(),
  });

  return res.status(201).json({
    success: true,
    document,
    model: embeddingResults[0]?.model,
    dimensions: embeddingResults[0]?.dimensions,
    totalChunks: storedCount,
    chunks: chunks.map((chunk) => ({
      chunkIndex: chunk.index,
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
      sourceType: result.sourceType,
      sourceId: result.sourceId,
      documentId: result.documentId,
      chunkIndex: result.chunkIndex,
      content: result.content,
      metadata: result.metadata,
      distance: result.distance,
      similarity: result.similarity,
      createdAt: result.createdAt,
    })),
  });
});
