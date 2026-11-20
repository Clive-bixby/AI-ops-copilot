import { toSql } from "pgvector";
import type { PoolClient } from "pg";

import { pool } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { IngestionValidationError } from "./errors.js";
import { getEmbeddingConfig } from "./embeddingConfig.js";
import type { EmbeddingConfig } from "./embeddingConfig.js";

export type SourceType = "document" | "log" | "ticket";

export const SOURCE_TYPES: readonly SourceType[] = ["document", "log", "ticket"];

export type IndexableChunk = {
  /** Position inside the source. Must be unique per source. */
  index: number;
  content: string;
  /** Fingerprint of the chunk text, used for change detection and debugging. */
  chunkHash: string;
  metadata?: Record<string, unknown>;
};

export type ReplaceSourceIndexInput = {
  organizationId: string;
  sourceType: SourceType;
  sourceId: string;
  /** Canonical source time, used by unified time filters. */
  sourceCreatedAt: Date | string | null;
  chunks: IndexableChunk[];
  embeddings: number[][];
  config?: EmbeddingConfig;
};

const INSERT_BATCH_SIZE = 200;

function requireId(value: string, label: string): string {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    throw new IngestionValidationError(`${label} is required`);
  }

  return trimmed;
}

function isSourceType(value: string): value is SourceType {
  return (SOURCE_TYPES as readonly string[]).includes(value);
}

function validateChunks(chunks: IndexableChunk[]): void {
  const seen = new Set<number>();

  chunks.forEach((chunk, position) => {
    if (!Number.isInteger(chunk.index) || chunk.index < 0) {
      throw new IngestionValidationError(
        `Chunk at position ${position} has an invalid index`
      );
    }

    if (seen.has(chunk.index)) {
      throw new IngestionValidationError(
        `Duplicate chunk index ${chunk.index} for the same source`
      );
    }
    seen.add(chunk.index);

    if (!chunk.content || chunk.content.trim().length === 0) {
      throw new IngestionValidationError(
        `Chunk ${chunk.index} content is required`
      );
    }

    if (!chunk.chunkHash) {
      throw new IngestionValidationError(
        `Chunk ${chunk.index} fingerprint is required`
      );
    }
  });
}

async function insertChunkBatch(
  client: PoolClient,
  input: ReplaceSourceIndexInput,
  chunks: IndexableChunk[],
  embeddings: number[][],
  config: EmbeddingConfig
): Promise<void> {
  const values: unknown[] = [];
  const placeholders: string[] = [];

  chunks.forEach((chunk, position) => {
    const embedding = embeddings[position];
    if (!embedding) {
      throw new IngestionValidationError(
        `Missing embedding for chunk ${chunk.index}`
      );
    }

    const base = values.length;
    values.push(
      input.organizationId,
      input.sourceType,
      input.sourceId,
      chunk.index,
      chunk.content.trim(),
      toSql(embedding),
      config.model,
      config.dimensions,
      chunk.chunkHash,
      chunk.metadata ? JSON.stringify(chunk.metadata) : null,
      input.sourceCreatedAt
    );

    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
        `$${base + 6}::vector, $${base + 7}, $${base + 8}, $${base + 9}, ` +
        `$${base + 10}::jsonb, $${base + 11}::timestamptz)`
    );
  });

  await client.query(
    `
    INSERT INTO source_chunks (
      organization_id,
      source_type,
      source_id,
      chunk_index,
      content,
      embedding,
      embedding_model,
      embedding_dimensions,
      chunk_hash,
      metadata,
      source_created_at
    )
    VALUES ${placeholders.join(", ")}
    `,
    values
  );
}

/**
 * Replace every indexed chunk of one source inside a single transaction.
 *
 * Deleting first is what makes reprocessing correct: an upsert by chunk index
 * leaves rows behind when a new version of the source produces fewer chunks,
 * and those stale rows keep answering searches with text that no longer exists
 * in the source. If embedding or insertion fails, the transaction rolls back and
 * the previous index stays intact.
 */
export async function replaceSourceIndex(
  input: ReplaceSourceIndexInput
): Promise<number> {
  const organizationId = requireId(input.organizationId, "Organization ID");
  const sourceId = requireId(input.sourceId, "Source ID");

  if (!isSourceType(input.sourceType)) {
    throw new IngestionValidationError(`Unsupported source type '${input.sourceType}'`);
  }

  if (!Array.isArray(input.chunks) || input.chunks.length === 0) {
    throw new IngestionValidationError("At least one chunk is required");
  }

  if (
    !Array.isArray(input.embeddings) ||
    input.embeddings.length !== input.chunks.length
  ) {
    throw new IngestionValidationError(
      "Chunks and embeddings must have the same length"
    );
  }

  validateChunks(input.chunks);

  const config = input.config ?? getEmbeddingConfig();
  input.embeddings.forEach((embedding, index) => {
    if (embedding.length !== config.dimensions) {
      throw new IngestionValidationError(
        `Embedding ${index} has ${embedding.length} dimensions; expected ${config.dimensions}`
      );
    }
  });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Two writers for the same source (a retried job, a manual reprocess) must
    // not interleave delete/insert and end up with a partial index.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${organizationId}:${input.sourceType}:${sourceId}`,
    ]);

    await client.query(
      `DELETE FROM source_chunks
       WHERE organization_id = $1 AND source_type = $2 AND source_id = $3`,
      [organizationId, input.sourceType, sourceId]
    );

    for (let start = 0; start < input.chunks.length; start += INSERT_BATCH_SIZE) {
      await insertChunkBatch(
        client,
        { ...input, organizationId, sourceId },
        input.chunks.slice(start, start + INSERT_BATCH_SIZE),
        input.embeddings.slice(start, start + INSERT_BATCH_SIZE),
        config
      );
    }

    await client.query("COMMIT");

    logger.info("ingestion.source_index_replaced", {
      organizationId,
      sourceType: input.sourceType,
      sourceId,
      chunkCount: input.chunks.length,
      embeddingModel: config.model,
      embeddingDimensions: config.dimensions,
    });

    return input.chunks.length;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error("ingestion.rollback_failed", {
        organizationId,
        sourceType: input.sourceType,
        sourceId,
        error: rollbackError,
      });
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Remove all indexed content for one source. Used when a source is emptied or
 * marked unsearchable without being deleted.
 */
export async function deleteSourceIndex(input: {
  organizationId: string;
  sourceType: SourceType;
  sourceId: string;
}): Promise<number> {
  const result = await pool.query(
    `DELETE FROM source_chunks
     WHERE organization_id = $1 AND source_type = $2 AND source_id = $3`,
    [input.organizationId, input.sourceType, input.sourceId]
  );

  return result.rowCount ?? 0;
}
