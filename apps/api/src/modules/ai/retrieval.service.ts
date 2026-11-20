import { generateEmbedding } from "./embedding.service.js";
import { searchFullText, searchSimilar } from "./vector.service.js";
import type {
  FullTextResult,
  SimilarityResult,
  VectorizableSourceType,
} from "./vector.service.js";
import { elapsedMs, logAIMetrics, nowMs } from "./aiMetrics.util.js";

export const DEFAULT_RETRIEVAL_LIMIT = 5;
export const MAX_RETRIEVAL_LIMIT = 10;
export const MIN_QUERY_LENGTH = 3;
export const MAX_QUERY_LENGTH = 500;
export const DEFAULT_MIN_SIMILARITY = 0.65;
const DEFAULT_PREVIEW_LENGTH = 180;
const DEFAULT_RRF_K = 60;
const CANDIDATE_MULTIPLIER = 4;
const MAX_CANDIDATE_LIMIT = 40;

export type RetrievalMode = "hybrid" | "vector";
export type MatchType = "vector" | "keyword" | "hybrid";

export type SearchRelevantChunk = {
  content: string;
  /** Cosine similarity, or null when the chunk was found only by keywords. */
  similarity: number | null;
  /** Fusion score (RRF). Higher is better; comparable within one response only. */
  score: number;
  matchType: MatchType;
  sourceType: VectorizableSourceType;
  sourceId: string;
  /** Present only for document chunks. */
  documentId: string | null;
  chunkIndex: number;
  preview: string;
};

export type RetrievalOptions = {
  organizationId: string;
  query: string;
  topK?: number;
  minSimilarity?: number;
  sourceTypes?: VectorizableSourceType[];
  /** Defaults to hybrid; `vector` reproduces the pre-Phase-2 behaviour. */
  mode?: RetrievalMode;
};

export type RetrievedContext = {
  content: string;
  sourceId: string;
  sourceType: VectorizableSourceType;
  similarity: number | null;
};

export type CitationSource = {
  sourceType: VectorizableSourceType;
  sourceId: string;
  documentId: string | null;
  matchType: MatchType;
  chunkIndex: number;
  similarity: number | null;
  score: number;
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

function getRrfK(): number {
  const rawValue = process.env.HYBRID_RRF_K;
  const parsed = rawValue ? Number(rawValue) : DEFAULT_RRF_K;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RRF_K;
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

export function validateSourceTypes(value: unknown): VectorizableSourceType[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new RetrievalValidationError("sourceTypes must be an array");
  }

  const allowed: VectorizableSourceType[] = ["document", "log", "ticket"];
  const unique: VectorizableSourceType[] = [];

  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.includes(entry as VectorizableSourceType)) {
      throw new RetrievalValidationError(
        `Unsupported source type '${String(entry)}'`
      );
    }

    const sourceType = entry as VectorizableSourceType;
    if (!unique.includes(sourceType)) {
      unique.push(sourceType);
    }
  }

  return unique;
}

export function validateRetrievalMode(value: unknown): RetrievalMode {
  if (value === undefined) {
    return "hybrid";
  }

  if (value === "hybrid" || value === "vector") {
    return value;
  }

  throw new RetrievalValidationError("mode must be 'hybrid' or 'vector'");
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

export type FusedCandidate = {
  id: string;
  sourceType: VectorizableSourceType;
  sourceId: string;
  documentId: string | null;
  chunkIndex: number;
  content: string;
  similarity: number | null;
  vectorRank: number | null;
  keywordRank: number | null;
  score: number;
};

/**
 * Reciprocal Rank Fusion: score = Σ 1 / (k + rank) over the arms that returned
 * the chunk. RRF compares positions, not raw scores, so a cosine similarity and
 * a ts_rank — which are on unrelated scales — can be combined without inventing
 * a calibration between them.
 */
export function fuseResults(input: {
  vectorResults: SimilarityResult[];
  keywordResults: FullTextResult[];
  limit: number;
  mode: RetrievalMode;
}): FusedCandidate[] {
  const k = getRrfK();
  const byKey = new Map<string, FusedCandidate>();

  const upsert = (candidate: {
    id: string;
    sourceType: VectorizableSourceType;
    sourceId: string;
    documentId: string | null;
    chunkIndex: number;
    content: string;
    similarity: number | null;
    vectorRank: number | null;
    keywordRank: number | null;
  }) => {
    const key = `${candidate.sourceType}:${candidate.sourceId}:${candidate.chunkIndex}`;
    const existing = byKey.get(key);

    const vectorScore =
      candidate.vectorRank === null ? 0 : 1 / (k + candidate.vectorRank);
    const keywordScore =
      candidate.keywordRank === null ? 0 : 1 / (k + candidate.keywordRank);

    if (!existing) {
      byKey.set(key, {
        ...candidate,
        score: vectorScore + keywordScore,
      });
      return;
    }

    existing.vectorRank = candidate.vectorRank ?? existing.vectorRank;
    existing.keywordRank = candidate.keywordRank ?? existing.keywordRank;
    existing.similarity = candidate.similarity ?? existing.similarity;
    existing.score =
      (existing.vectorRank === null ? 0 : 1 / (k + existing.vectorRank)) +
      (existing.keywordRank === null ? 0 : 1 / (k + existing.keywordRank));
  };

  input.vectorResults.forEach((hit, index) => {
    upsert({
      id: hit.id,
      sourceType: hit.sourceType,
      sourceId: hit.sourceId,
      documentId: hit.documentId,
      chunkIndex: hit.chunkIndex,
      content: hit.content,
      similarity: hit.similarity,
      vectorRank: index + 1,
      keywordRank: null,
    });
  });

  if (input.mode === "hybrid") {
    input.keywordResults.forEach((hit, index) => {
      upsert({
        id: hit.id,
        sourceType: hit.sourceType,
        sourceId: hit.sourceId,
        documentId: hit.documentId,
        chunkIndex: hit.chunkIndex,
        content: hit.content,
        similarity: null,
        vectorRank: null,
        keywordRank: index + 1,
      });
    });
  }

  // Deduplicate near-identical text that different sources happen to contain;
  // the first (highest-RRF) copy wins.
  const seenFingerprints = new Set<string>();
  const unique: FusedCandidate[] = [];

  for (const candidate of [...byKey.values()].sort(compareCandidates)) {
    const fingerprint = normalizeFingerprint(candidate.content);
    if (seenFingerprints.has(fingerprint)) {
      continue;
    }
    seenFingerprints.add(fingerprint);
    unique.push(candidate);
  }

  return unique.slice(0, input.limit);
}

function compareCandidates(a: FusedCandidate, b: FusedCandidate): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }

  const similarityDelta = (b.similarity ?? -1) - (a.similarity ?? -1);
  if (similarityDelta !== 0) {
    return similarityDelta;
  }

  return a.chunkIndex - b.chunkIndex;
}

export function toCitationSource(candidate: FusedCandidate): CitationSource {
  const matchType: MatchType =
    candidate.vectorRank !== null && candidate.keywordRank !== null
      ? "hybrid"
      : candidate.vectorRank !== null
        ? "vector"
        : "keyword";

  return {
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    documentId: candidate.documentId,
    matchType,
    chunkIndex: candidate.chunkIndex,
    similarity:
      candidate.similarity === null
        ? null
        : Number(candidate.similarity.toFixed(6)),
    score: Number(candidate.score.toFixed(6)),
    preview: buildPreview(candidate.content),
    content: candidate.content,
  };
}

/**
 * Find the most relevant indexed chunks for a natural-language query.
 */
export async function searchRelevantChunks(
  query: string,
  organizationId: string,
  limit?: number,
  options?: {
    sourceTypes?: VectorizableSourceType[];
    mode?: RetrievalMode;
  }
): Promise<SearchRelevantChunk[]> {
  const retrievalOptions: RetrievalOptions = {
    query,
    organizationId,
    minSimilarity: getConfiguredMinSimilarity(),
    mode: options?.mode ?? "hybrid",
  };

  if (limit !== undefined) {
    retrievalOptions.topK = limit;
  }

  if (options?.sourceTypes !== undefined) {
    retrievalOptions.sourceTypes = options.sourceTypes;
  }

  const result = await retrieveRelevantChunks(retrievalOptions);

  return result.chunks.map((chunk) => ({
    content: chunk.content,
    similarity: chunk.similarity,
    score: chunk.score,
    matchType: chunk.matchType,
    sourceType: chunk.sourceType,
    sourceId: chunk.sourceId,
    documentId: chunk.documentId,
    chunkIndex: chunk.chunkIndex,
    preview: chunk.preview,
  }));
}

export async function retrieveRelevantChunks(
  options: RetrievalOptions
): Promise<RetrievalResult> {
  const startedAt = nowMs();
  const trimmedQuery = validateSearchQuery(options.query);
  const orgId = validateOrganizationId(options.organizationId);
  const searchLimit = validateRetrievalLimit(options.topK);
  const mode = options.mode ?? "hybrid";
  const minSimilarity = normalizeMinSimilarity(options.minSimilarity);
  const candidateLimit = Math.min(
    searchLimit * CANDIDATE_MULTIPLIER,
    MAX_CANDIDATE_LIMIT
  );
  const sourceFilters =
    options.sourceTypes && options.sourceTypes.length > 0
      ? { sourceTypes: options.sourceTypes }
      : undefined;

  logAIMetrics("retrieval.started", {
    organizationId: orgId,
    queryLength: trimmedQuery.length,
    topK: searchLimit,
    candidateLimit,
    minSimilarity,
    mode,
    sourceTypes: options.sourceTypes ?? "all",
  });

  const embeddingStartedAt = nowMs();

  // The keyword arm does not need the embedding, so both start together.
  const [embeddingResult, keywordResults] = await Promise.all([
    generateEmbedding(trimmedQuery),
    mode === "hybrid"
      ? searchFullText(trimmedQuery, orgId, candidateLimit, sourceFilters)
      : Promise.resolve([] as FullTextResult[]),
  ]);
  const embeddingMs = elapsedMs(embeddingStartedAt);

  logAIMetrics("retrieval.embedding_generated", {
    organizationId: orgId,
    model: embeddingResult.model,
    dimensions: embeddingResult.dimensions,
    embeddingMs,
  });

  const vectorStartedAt = nowMs();
  const vectorResults = await searchSimilar(
    embeddingResult.embedding,
    orgId,
    candidateLimit,
    minSimilarity,
    sourceFilters
  );
  const vectorSearchMs = elapsedMs(vectorStartedAt);

  const fused = fuseResults({
    vectorResults,
    keywordResults,
    limit: searchLimit,
    mode,
  });
  const chunks = fused.map(toCitationSource);
  const retrievalMs = elapsedMs(startedAt) - embeddingMs;

  logAIMetrics("retrieval.completed", {
    organizationId: orgId,
    mode,
    rawCount: vectorResults.length + keywordResults.length,
    fusedCount: fused.length,
    embeddingMs,
    vectorSearchMs,
    retrievalMs,
  });

  return {
    chunks,
    metrics: {
      embeddingMs,
      retrievalMs,
      retrievedChunkCount: fused.length,
    },
  };
}

/**
 * RAG-compatible retrieval wrapper. Returns flat evidence records with their
 * real source identity, so a log group or ticket is never reported as a
 * document.
 */
export async function retrieveContext(
  options: RetrievalOptions
): Promise<RetrievedContext[]> {
  const result = await retrieveRelevantChunks(options);

  return result.chunks.map((chunk) => ({
    content: chunk.content,
    sourceId: chunk.sourceId,
    sourceType: chunk.sourceType,
    similarity: chunk.similarity,
  }));
}
