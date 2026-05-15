import { generateEmbedding } from "./embedding.service.js";
import { searchSimilar } from "./vector.service.js";

export const DEFAULT_RETRIEVAL_LIMIT = 5;
export const MAX_RETRIEVAL_LIMIT = 10;
export const MIN_QUERY_LENGTH = 3;
export const MAX_QUERY_LENGTH = 500;
export const DEFAULT_MIN_SIMILARITY = 0.7;

export type SearchRelevantChunk = {
  content: string;
  similarity: number;
  documentId: string;
  chunkIndex: number;
};

export type RetrievalOptions = {
  organizationId: string;
  query: string;
  topK?: number;
  sourceTypes?: ("document" | "log" | "ticket")[];
};

export type RetrievedContext = {
  content: string;
  sourceId: string;
  sourceType: string;
  similarity: number;
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
  const startedAt = Date.now();
  const trimmedQuery = validateSearchQuery(query);
  const orgId = validateOrganizationId(organizationId);
  const searchLimit = validateRetrievalLimit(limit);
  const minSimilarity = getConfiguredMinSimilarity();

  console.log("Semantic search query received", {
    organizationId: orgId,
    queryLength: trimmedQuery.length,
    limit: searchLimit,
    minSimilarity,
  });

  const embeddingResult = await generateEmbedding(trimmedQuery);
  console.log("Semantic search embedding generated", {
    organizationId: orgId,
    model: embeddingResult.model,
    dimensions: embeddingResult.dimensions,
  });

  const results = await searchSimilar(
    embeddingResult.embedding,
    orgId,
    searchLimit,
    minSimilarity
  );

  const executionTimeMs = Date.now() - startedAt;
  console.log("Semantic search completed", {
    organizationId: orgId,
    resultCount: results.length,
    executionTimeMs,
  });

  return results.map((result) => ({
    content: result.content,
    similarity: result.similarity,
    documentId: result.documentId,
    chunkIndex: result.chunkIndex,
  }));
}

/**
 * RAG-compatible retrieval wrapper kept for the upcoming Day 6 generation
 * pipeline. Day 5 indexes document chunks only, so sourceType is fixed.
 */
export async function retrieveContext(
  options: RetrievalOptions
): Promise<RetrievedContext[]> {
  const chunks = await searchRelevantChunks(
    options.query,
    options.organizationId,
    options.topK
  );

  return chunks.map((chunk) => ({
    content: chunk.content,
    sourceId: chunk.documentId,
    sourceType: "document",
    similarity: chunk.similarity,
  }));
}
