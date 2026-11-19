import { generateEmbedding } from "./embedding.service.js";
import { searchSimilar } from "./vector.service.js";
import type { SimilarityResult } from "./vector.service.js";
import { elapsedMs, logAIMetrics, nowMs } from "./aiMetrics.util.js";

export const DEFAULT_RETRIEVAL_LIMIT = 5;
export const MAX_RETRIEVAL_LIMIT = 10;
export const MIN_QUERY_LENGTH = 3;
export const MAX_QUERY_LENGTH = 500;
export const DEFAULT_MIN_SIMILARITY = 0.65;
const DEFAULT_PREVIEW_LENGTH = 180;

export type SearchRelevantChunk = {
  content: string;
  similarity: number;
  documentId: string;
  chunkIndex: number;
  preview: string;
};

export type RetrievalOptions = {
  organizationId: string;
  query: string;
  topK?: number;
  minSimilarity?: number;
  sourceTypes?: ("document" | "log" | "ticket")[];
};

export type RetrievedContext = {
  content: string;
  sourceId: string;
  sourceType: string;
  similarity: number;
};

export type CitationSource = {
  /** Vector hits always come from indexed document chunks. */
  sourceType: "document";
  matchType: "vector";
  documentId: string;
  chunkIndex: number;
  similarity: number;
  preview: string;
  content: string;
};

export type RetrievalMetrics = {
  embeddingMs: number;
  retrievalMs: number;
  retrievedChunkCount: number;
};

export type RetrievalResult = {
  chunks: CitationSource[];
  metrics: RetrievalMetrics;
};

export class RetrievalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrievalValidationError";
  }
}

function getConfiguredMinSimilarity(): number {
  const rawThreshold = process.env.AI_SEARCH_MIN_SIMILARITY;
  if (rawThreshold === undefined || rawThreshold.trim() === "") {
    return DEFAULT_MIN_SIMILARITY;
  }

  const threshold = Number(rawThreshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    console.warn("Invalid AI_SEARCH_MIN_SIMILARITY; using default", {
      value: rawThreshold,
      defaultValue: DEFAULT_MIN_SIMILARITY,
    });

    return DEFAULT_MIN_SIMILARITY;
  }

  return threshold;
}

function normalizeMinSimilarity(minSimilarity?: number): number {
  if (minSimilarity === undefined) {
    return getConfiguredMinSimilarity();
  }

  if (
    typeof minSimilarity !== "number" ||
    !Number.isFinite(minSimilarity) ||
    minSimilarity < 0 ||
    minSimilarity > 1
  ) {
    throw new RetrievalValidationError(
      "Minimum similarity must be a number between 0 and 1"
    );
  }

  return Math.max(minSimilarity, DEFAULT_MIN_SIMILARITY);
}

export function validateSearchQuery(query: unknown): string {
  if (typeof query !== "string") {
    throw new RetrievalValidationError("Query must be a string");
  }

  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) {
    throw new RetrievalValidationError(
      `Query must be at least ${MIN_QUERY_LENGTH} characters long`
    );
  }

  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new RetrievalValidationError(
      `Query must be no more than ${MAX_QUERY_LENGTH} characters long`
    );
  }

  return trimmed;
}

export function validateRetrievalLimit(limit?: unknown): number {
  if (limit === undefined) {
    return DEFAULT_RETRIEVAL_LIMIT;
  }

  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_RETRIEVAL_LIMIT
  ) {
    throw new RetrievalValidationError(
      `Limit must be an integer between 1 and ${MAX_RETRIEVAL_LIMIT}`
    );
  }

  return limit;
}

function validateOrganizationId(organizationId: unknown): string {
  if (typeof organizationId !== "string" || organizationId.trim().length === 0) {
    throw new RetrievalValidationError("Organization ID is required");
  }

  return organizationId.trim();
}

function normalizeFingerprint(content: string): string {
  return content
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim()
    .slice(0, 500);
}

function buildPreview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();

  if (normalized.length <= DEFAULT_PREVIEW_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, DEFAULT_PREVIEW_LENGTH).trim()}...`;
}

function dedupeChunks(chunks: SimilarityResult[]): SimilarityResult[] {
  const seenSourceKeys = new Set<string>();
  const seenFingerprints = new Set<string>();
  const deduped: SimilarityResult[] = [];

  for (const chunk of chunks) {
    const sourceKey = `${chunk.documentId}:${chunk.chunkIndex}`;
    const fingerprint = normalizeFingerprint(chunk.content);

    if (seenSourceKeys.has(sourceKey) || seenFingerprints.has(fingerprint)) {
      continue;
    }

    seenSourceKeys.add(sourceKey);
    seenFingerprints.add(fingerprint);
    deduped.push(chunk);
  }

  return deduped;
}

function preserveDocumentOrderWhenUseful(
  chunks: SimilarityResult[]
): SimilarityResult[] {
  const byDocument = new Map<string, SimilarityResult[]>();

  for (const chunk of chunks) {
    const existing = byDocument.get(chunk.documentId) ?? [];
    existing.push(chunk);
    byDocument.set(chunk.documentId, existing);
  }

  if (byDocument.size !== 1) {
    return chunks;
  }

  return [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
}

function toCitationSource(chunk: SimilarityResult): CitationSource {
  return {
    sourceType: "document",
    matchType: "vector",
    documentId: chunk.documentId,
    chunkIndex: chunk.chunkIndex,
    similarity: chunk.similarity,
    preview: buildPreview(chunk.content),
    content: chunk.content,
  };
}

/**
 * Find the most relevant document chunks for a natural-language query.
 *
 * pgvector's cosine operator returns distance, where lower is better. The API
 * exposes similarity instead (`1 - distance`) so higher scores feel natural to
 * clients and are easier to threshold for RAG.
 */
export async function searchRelevantChunks(
  query: string,
  organizationId: string,
  limit?: number
): Promise<SearchRelevantChunk[]> {
  const options: RetrievalOptions = {
    query,
    organizationId,
    minSimilarity: getConfiguredMinSimilarity(),
  };

  if (limit !== undefined) {
    options.topK = limit;
  }

  const result = await retrieveRelevantChunks(options);

  return result.chunks;
}

export async function retrieveRelevantChunks(
  options: RetrievalOptions
): Promise<RetrievalResult> {
  const startedAt = nowMs();
  const trimmedQuery = validateSearchQuery(options.query);
  const orgId = validateOrganizationId(options.organizationId);
  const searchLimit = validateRetrievalLimit(options.topK);
  const minSimilarity = normalizeMinSimilarity(options.minSimilarity);
  const candidateLimit = Math.min(searchLimit * 2, MAX_RETRIEVAL_LIMIT);

  logAIMetrics("retrieval.started", {
    organizationId: orgId,
    queryLength: trimmedQuery.length,
    topK: searchLimit,
    candidateLimit,
    minSimilarity,
  });

  const embeddingStartedAt = nowMs();
  const embeddingResult = await generateEmbedding(trimmedQuery);
  const embeddingMs = elapsedMs(embeddingStartedAt);

  logAIMetrics("retrieval.embedding_generated", {
    organizationId: orgId,
    model: embeddingResult.model,
    dimensions: embeddingResult.dimensions,
    embeddingMs,
  });

  const vectorStartedAt = nowMs();
  const rawResults = await searchSimilar(
    embeddingResult.embedding,
    orgId,
    candidateLimit,
    minSimilarity
  );
  const vectorSearchMs = elapsedMs(vectorStartedAt);

  const rankedChunks = dedupeChunks(rawResults)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, searchLimit);
  const orderedChunks = preserveDocumentOrderWhenUseful(rankedChunks);
  const chunks = orderedChunks.map(toCitationSource);
  const retrievalMs = elapsedMs(startedAt) - embeddingMs;

  logAIMetrics("retrieval.completed", {
    organizationId: orgId,
    rawCount: rawResults.length,
    dedupedCount: chunks.length,
    embeddingMs,
    vectorSearchMs,
    retrievalMs,
  });

  return {
    chunks,
    metrics: {
      embeddingMs,
      retrievalMs,
      retrievedChunkCount: rawResults.length,
    },
  };
}

/**
 * RAG-compatible retrieval wrapper kept for the upcoming Day 6 generation
 * pipeline. Day 5 indexes document chunks only, so sourceType is fixed.
 */
export async function retrieveContext(
  options: RetrievalOptions
): Promise<RetrievedContext[]> {
  const result = await retrieveRelevantChunks(options);

  return result.chunks.map((chunk) => ({
    content: chunk.content,
    sourceId: chunk.documentId,
    sourceType: "document",
    similarity: chunk.similarity,
  }));
}
