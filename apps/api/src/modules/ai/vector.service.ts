import { toSql } from "pgvector";

import { pool } from "../../core/db.js";
import { getEmbeddingConfig } from "../ingestion/embeddingConfig.js";

export type VectorizableSourceType = "document" | "log" | "ticket";

const DEFAULT_SEARCH_LIMIT = 5;
// The public API limit stays at 10; the candidate pool used before fusion is
// larger so each arm has something to contribute to the merged ranking.
const MAX_SEARCH_LIMIT = 50;

export type FullTextResult = {
  id: string;
  sourceType: VectorizableSourceType;
  sourceId: string;
  documentId: string | null;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  sourceCreatedAt: string | null;
  rank: number;
};

type FullTextRow = {
  id: string;
  source_type: VectorizableSourceType;
  source_id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  source_created_at: string | null;
  rank: string | number;
};

type SimilarityRow = {
  id: string;
  source_type: VectorizableSourceType;
  source_id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown> | null;
  distance: string | number;
  similarity: string | number;
  created_at: string;
  source_created_at: string | null;
};

export type SimilarityResult = {
  id: string;
  sourceType: VectorizableSourceType;
  sourceId: string;
  /** Convenience discriminator: only document results have a document id. */
  documentId: string | null;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown> | null;
  distance: number;
  similarity: number;
  createdAt: string;
  sourceCreatedAt: string | null;
};

export class VectorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorValidationError";
  }
}

function validateId(value: string, label: string): string {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    throw new VectorValidationError(`${label} is required`);
  }

  return trimmed;
}

function validateEmbedding(embedding: number[], label: string): void {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new VectorValidationError(`${label} must be a non-empty number array`);
  }

  if (embedding.length !== getEmbeddingConfig().dimensions) {
    throw new VectorValidationError(
      `${label} must have ${getEmbeddingConfig().dimensions} dimensions; received ${embedding.length}`
    );
  }

  const hasInvalidValue = embedding.some((value) => !Number.isFinite(value));
  if (hasInvalidValue) {
    throw new VectorValidationError(`${label} must contain only finite numbers`);
  }
}

function normalizeLimit(limit?: number): number {
  if (limit === undefined) {
    return DEFAULT_SEARCH_LIMIT;
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new VectorValidationError("Search limit must be a positive integer");
  }

  if (limit > MAX_SEARCH_LIMIT) {
    throw new VectorValidationError(
      `Search limit must be less than or equal to ${MAX_SEARCH_LIMIT}`
    );
  }

  return limit;
}

function normalizeSimilarityThreshold(minSimilarity?: number): number {
  if (minSimilarity === undefined) {
    return 0;
  }

  if (
    typeof minSimilarity !== "number" ||
    !Number.isFinite(minSimilarity) ||
    minSimilarity < 0 ||
    minSimilarity > 1
  ) {
    throw new VectorValidationError(
      "Minimum similarity must be a number between 0 and 1"
    );
  }

  return minSimilarity;
}

function rowToSimilarityResult(row: SimilarityRow): SimilarityResult {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    documentId: row.source_type === "document" ? row.source_id : null,
    chunkIndex: row.chunk_index,
    content: row.content,
    metadata: row.metadata,
    distance: Number(row.distance),
    similarity: Number(row.similarity),
    createdAt: row.created_at,
    sourceCreatedAt: row.source_created_at,
  };
}

/**
 * Cosine search over the unified index.
 *
 * Only rows written with the currently configured model and width are compared:
 * vectors from another embedding model are not comparable, and silently mixing
 * them would produce confident-looking nonsense. Organization scoping is part of
 * the query, never applied after the fact.
 */
export async function searchSimilar(
  queryEmbedding: number[],
  organizationId: string,
  limit?: number,
  minSimilarity?: number,
  options?: { sourceTypes?: VectorizableSourceType[] }
): Promise<SimilarityResult[]> {
  const orgId = validateId(organizationId, "Organization ID");
  const searchLimit = normalizeLimit(limit);
  const similarityThreshold = normalizeSimilarityThreshold(minSimilarity);
  const maxDistance = 1 - similarityThreshold;
  validateEmbedding(queryEmbedding, "Query embedding");

  const config = getEmbeddingConfig();
  const sourceTypes =
    options?.sourceTypes && options.sourceTypes.length > 0
      ? options.sourceTypes
      : null;

  const result = await pool.query<SimilarityRow>(
    `
    SELECT
      id,
      source_type,
      source_id,
      chunk_index,
      content,
      metadata,
      embedding <=> $2::vector AS distance,
      1 - (embedding <=> $2::vector) AS similarity,
      created_at,
      source_created_at
    FROM source_chunks
    WHERE organization_id = $1
      AND embedding_model = $5
      AND embedding_dimensions = $6
      AND (embedding <=> $2::vector) <= $4
      AND ($7::text[] IS NULL OR source_type = ANY($7::text[]))
    ORDER BY embedding <=> $2::vector
    LIMIT $3
    `,
    [
      orgId,
      toSql(queryEmbedding),
      searchLimit,
      maxDistance,
      config.model,
      config.dimensions,
      sourceTypes,
    ]
  );

  return result.rows.map(rowToSimilarityResult);
}

/**
 * Keyword arm: Postgres full-text search over the generated `tsv` column.
 *
 * The arm is recall-oriented. It ORs the lexemes produced by the `english`
 * configuration instead of requiring every word to appear, because operational
 * questions often add words the runbook does not use ("PGPOOL_MAX environment
 * variable" against a document that only says "PGPOOL_MAX"). `ts_rank_cd`
 * rewards chunks that cover more of the query, and the caller fuses the arm by
 * rank rather than by raw score.
 *
 * Lexemes come from `to_tsvector`, and `quote_literal` keeps operator
 * characters out of the tsquery. A query made only of stop words produces no
 * lexemes and therefore no matches, which is the honest result rather than an
 * error.
 */
export async function searchFullText(
  query: string,
  organizationId: string,
  limit?: number,
  options?: { sourceTypes?: VectorizableSourceType[] }
): Promise<FullTextResult[]> {
  const orgId = validateId(organizationId, "Organization ID");
  const searchLimit = normalizeLimit(limit);
  const trimmedQuery = (query || "").trim();

  if (!trimmedQuery) {
    throw new VectorValidationError("Query is required");
  }

  const sourceTypes =
    options?.sourceTypes && options.sourceTypes.length > 0
      ? options.sourceTypes
      : null;

  const result = await pool.query<FullTextRow>(
    `
    WITH search_query AS (
      SELECT string_agg(quote_literal(lexeme), ' | ')::tsquery AS query
      FROM unnest(tsvector_to_array(to_tsvector('english', $2))) AS lexeme
    )
    SELECT
      sc.id,
      sc.source_type,
      sc.source_id,
      sc.chunk_index,
      sc.content,
      sc.metadata,
      sc.created_at,
      sc.source_created_at,
      ts_rank_cd(sc.tsv, search_query.query) AS rank
    FROM source_chunks sc, search_query
    WHERE sc.organization_id = $1
      AND sc.tsv @@ search_query.query
      AND ($3::text[] IS NULL OR sc.source_type = ANY($3::text[]))
    ORDER BY rank DESC, sc.id
    LIMIT $4
    `,
    [orgId, trimmedQuery, sourceTypes, searchLimit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    documentId: row.source_type === "document" ? row.source_id : null,
    chunkIndex: row.chunk_index,
    content: row.content,
    metadata: row.metadata,
    createdAt: row.created_at,
    sourceCreatedAt: row.source_created_at,
    rank: Number(row.rank),
  }));
}
