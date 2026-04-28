// ---------------------------------------------------------------------------
// RAG Service — Full Retrieval-Augmented Generation Pipeline
// ---------------------------------------------------------------------------
//
// Purpose: Top-level orchestrator that combines:
//   1. Retrieval (embedding → vector search → context)
//   2. Prompt construction (system prompt + context + user query)
//   3. LLM call (Ollama or external provider)
//   4. Response formatting
//
// Will be implemented in Phase 2, Day 4–5.
// ---------------------------------------------------------------------------

export type RAGRequest = {
  organizationId: string;
  query: string;
  sourceTypes?: ("document" | "log" | "ticket")[];
};

export type RAGResponse = {
  answer: string;
  sources: {
    sourceId: string;
    sourceType: string;
    content: string;
    similarity: number;
  }[];
};

/**
 * Run the full RAG pipeline: retrieve context → build prompt → call LLM.
 *
 * @todo Implement in Phase 2, Day 4
 */
export async function runRAG(_request: RAGRequest): Promise<RAGResponse> {
  throw new Error("runRAG is not yet implemented");
}
