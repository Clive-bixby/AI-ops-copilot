// ---------------------------------------------------------------------------
// Retrieval Service — Context Retrieval for RAG
// ---------------------------------------------------------------------------
//
// Purpose: Orchestrate the retrieval side of RAG:
//   1. Embed the user's query
//   2. Search pgvector for similar chunks
//   3. Rank & filter results
//   4. Return formatted context for the LLM prompt
//
// Will be implemented in Phase 2, Day 3–4.
// ---------------------------------------------------------------------------

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

/**
 * Retrieve the most relevant context chunks for a given query
 * within an organization.
 *
 * @todo Implement in Phase 2, Day 3
 */
export async function retrieveContext(
  _options: RetrievalOptions
): Promise<RetrievedContext[]> {
  throw new Error("retrieveContext is not yet implemented");
}
