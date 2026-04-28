// ---------------------------------------------------------------------------
// Vector Service — pgvector Storage & Similarity Search
// ---------------------------------------------------------------------------
//
// Purpose: Store embedding vectors in PostgreSQL (pgvector) and perform
// similarity searches. All queries are scoped by organization_id to enforce
// multi-tenant isolation.
//
// Will be implemented in Phase 2, Day 2–3.
// ---------------------------------------------------------------------------

export type VectorRecord = {
  id: string;
  organizationId: string;
  sourceId: string;
  sourceType: "document" | "log" | "ticket";
  chunkIndex: number;
  content: string;
  embedding: number[];
  createdAt: Date;
};

export type SimilarityResult = {
  id: string;
  sourceId: string;
  sourceType: string;
  content: string;
  similarity: number;
};

/**
 * Store an embedding vector alongside its source chunk in pgvector.
 *
 * @todo Implement in Phase 2, Day 2
 */
export async function storeVector(
  _record: Omit<VectorRecord, "id" | "createdAt">
): Promise<VectorRecord> {
  throw new Error("storeVector is not yet implemented");
}

/**
 * Find the top-K most similar vectors for a query embedding,
 * scoped to the given organization.
 *
 * @todo Implement in Phase 2, Day 2
 */
export async function searchSimilar(
  _organizationId: string,
  _queryEmbedding: number[],
  _topK?: number
): Promise<SimilarityResult[]> {
  throw new Error("searchSimilar is not yet implemented");
}
