import { toSql } from "pgvector";
import type { PoolClient } from "pg";

import { pool } from "../../core/db.js";

const EXPECTED_EMBEDDING_DIMENSIONS = 768;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 25;

export type VectorChunkInput = {
  content: string;
  index?: number;
  metadata?: Record<string, unknown>;
};

type DocumentChunkRow = {
  id: string;
  document_id: string;
  organization_id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type SimilarityRow = {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown> | null;
  distance: string | number;
  score: string | number;
  created_at: string;
};

export type StoredDocumentChunk = {
  id: string;
  documentId: string;
  organizationId: string;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type SimilarityResult = {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown> | null;
  distance: number;
  score: number;
  createdAt: string;
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

  if (embedding.length !== EXPECTED_EMBEDDING_DIMENSIONS) {
    throw new VectorValidationError(
      `${label} must have ${EXPECTED_EMBEDDING_DIMENSIONS} dimensions; received ${embedding.length}`
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

  return Math.min(limit, MAX_SEARCH_LIMIT);
}

function rowToStoredChunk(row: DocumentChunkRow): StoredDocumentChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    organizationId: row.organization_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

function rowToSimilarityResult(row: SimilarityRow): SimilarityResult {
  return {
    id: row.id,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    metadata: row.metadata,
    distance: Number(row.distance),
    score: Number(row.score),
    createdAt: row.created_at,
  };
}

async function executeInsertBatch(
  client: PoolClient,
  chunks: VectorChunkInput[],
  embeddings: number[][],
  documentId: string,
  organizationId: string
): Promise<StoredDocumentChunk[]> {
  const values: unknown[] = [];
  const placeholders: string[] = [];

  chunks.forEach((chunk, index) => {
    const embedding = embeddings[index];
    if (!embedding) {
      throw new VectorValidationError(`Missing embedding for chunk ${index}`);
    }

    validateEmbedding(embedding, `Embedding for chunk ${index}`);

    const content = (chunk.content || "").trim();
    if (!content) {
      throw new VectorValidationError(`Chunk ${index} content is required`);
    }

    const chunkIndex = chunk.index ?? index;
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw new VectorValidationError(`Chunk ${index} has an invalid index`);
    }

    const base = values.length;
    values.push(
      documentId,
      organizationId,
      chunkIndex,
      content,
      toSql(embedding),
      chunk.metadata ? JSON.stringify(chunk.metadata) : null
    );

    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::vector, $${base + 6}::jsonb)`
    );
  });

  const result = await client.query<DocumentChunkRow>(
    `
    INSERT INTO document_chunks (
      document_id,
      organization_id,
      chunk_index,
      content,
      embedding,
      metadata
    )
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (document_id, chunk_index)
    DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      content = EXCLUDED.content,
      embedding = EXCLUDED.embedding,
      metadata = EXCLUDED.metadata
    RETURNING
      id,
      document_id,
      organization_id,
      chunk_index,
      content,
      metadata,
      created_at
    `,
    values
  );

  return result.rows.map(rowToStoredChunk);
}

export async function insertChunks(
  chunks: VectorChunkInput[],
  embeddings: number[][],
  documentId: string,
  organizationId: string
): Promise<StoredDocumentChunk[]> {
  const docId = validateId(documentId, "Document ID");
  const orgId = validateId(organizationId, "Organization ID");

  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new VectorValidationError("At least one chunk is required");
  }

  if (!Array.isArray(embeddings) || chunks.length !== embeddings.length) {
    throw new VectorValidationError(
      "Chunks and embeddings must have the same length"
    );
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const storedChunks = await executeInsertBatch(
      client,
      chunks,
      embeddings,
      docId,
      orgId
    );
    await client.query("COMMIT");

    return storedChunks;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Failed to rollback vector insert transaction", rollbackError);
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function searchSimilar(
  queryEmbedding: number[],
  organizationId: string,
  limit?: number
): Promise<SimilarityResult[]> {
  const orgId = validateId(organizationId, "Organization ID");
  const searchLimit = normalizeLimit(limit);
  validateEmbedding(queryEmbedding, "Query embedding");

  const result = await pool.query<SimilarityRow>(
    `
    SELECT
      id,
      document_id,
      chunk_index,
      content,
      metadata,
      embedding <=> $2::vector AS distance,
      1 - (embedding <=> $2::vector) AS score,
      created_at
    FROM document_chunks
    WHERE organization_id = $1
    ORDER BY embedding <=> $2::vector
    LIMIT $3
    `,
    [orgId, toSql(queryEmbedding), searchLimit]
  );

  return result.rows.map(rowToSimilarityResult);
}
