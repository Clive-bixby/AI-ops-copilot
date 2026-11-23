import fs from "fs/promises";

import { pool } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { chunkText } from "../ai/chunk.service.js";
import { parseDocument } from "../ai/documentParser.service.js";
import {
  updateDocumentContent,
  updateDocumentProcessingStatus,
} from "../documents/documents.service.js";
import { embedTexts } from "./embed.service.js";
import {
  getEmbeddingConfig,
  hashContent,
} from "./embeddingConfig.js";
import { IngestionValidationError, SourceNotFoundError } from "./errors.js";
import { replaceSourceIndex } from "./sourceIndex.service.js";

export type DocumentIngestResult = {
  status: "indexed" | "unchanged";
  documentId: string;
  chunkCount: number;
  /** Chunks actually sent to the embedding model. Zero when the index was current. */
  embeddedChunkCount: number;
  contentHash: string;
};

type DocumentRow = {
  id: string;
  content: string | null;
  created_at: string;
  processing_status: string;
  content_hash: string | null;
};

/**
 * Delete an uploaded original. Originals are only needed until their text has
 * been extracted; keeping them forever leaks disk space and retains user data
 * the system no longer needs.
 */
export async function removeUploadedFile(filePath: string): Promise<void> {
  const target = (filePath || "").trim();
  if (!target) {
    return;
  }

  try {
    await fs.unlink(target);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";

    if (code !== "ENOENT") {
      logger.warn("ingestion.uploaded_file_delete_failed", {
        filePath: target,
        error,
      });
    }
  }
}

async function hasCurrentIndex(input: {
  organizationId: string;
  documentId: string;
  contentHash: string;
}): Promise<boolean> {
  const config = getEmbeddingConfig();

  const result = await pool.query<{ current: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1
      FROM source_chunks
      WHERE organization_id = $1
        AND source_type = 'document'
        AND source_id = $2
        AND embedding_model = $3
        AND embedding_dimensions = $4
    ) AS current
    `,
    [input.organizationId, input.documentId, config.model, config.dimensions]
  );

  return result.rows[0]?.current === true;
}

async function loadDocument(
  organizationId: string,
  documentId: string
): Promise<DocumentRow> {
  const result = await pool.query<DocumentRow>(
    `SELECT id, content, created_at, processing_status, content_hash
     FROM documents
     WHERE id = $1 AND organization_id = $2`,
    [documentId, organizationId]
  );

  const document = result.rows[0];
  if (!document) {
    throw new SourceNotFoundError("Document not found");
  }

  return document;
}

/**
 * Parse (when a file is supplied), chunk, embed and index one document.
 *
 * The tenant check is part of the lookup: a document id alone never authorizes
 * work. Re-indexing unchanged content with the same embedding model is skipped,
 * so a retried job does not spend embedding budget twice.
 *
 * A failure is recorded on the document row and rethrown; it is never converted
 * into a success result.
 */
export async function indexDocument(input: {
  organizationId: string;
  documentId: string;
  filePath?: string;
  deleteFileAfter?: boolean;
}): Promise<DocumentIngestResult> {
  const organizationId = (input.organizationId || "").trim();
  const documentId = (input.documentId || "").trim();

  if (!organizationId) {
    throw new IngestionValidationError("Organization ID is required");
  }

  if (!documentId) {
    throw new IngestionValidationError("Document ID is required");
  }

  let indexed = false;

  try {
    const document = await loadDocument(organizationId, documentId);

    await updateDocumentProcessingStatus(
      documentId,
      organizationId,
      "processing"
    );

    const text = input.filePath
      ? await parseDocument(input.filePath)
      : (document.content || "").trim();

    if (!text) {
      throw new IngestionValidationError(
        "Document has no extracted text to index"
      );
    }

    const contentHash = hashContent(text);

    if (
      document.content_hash === contentHash &&
      (await hasCurrentIndex({ organizationId, documentId, contentHash }))
    ) {
      await updateDocumentContent(documentId, organizationId, text, contentHash);
      await updateDocumentProcessingStatus(
        documentId,
        organizationId,
        "processed"
      );

      const existing = await pool.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total
         FROM source_chunks
         WHERE organization_id = $1 AND source_type = 'document' AND source_id = $2`,
        [organizationId, documentId]
      );

      logger.info("ingestion.document_unchanged", {
        organizationId,
        documentId,
        contentHash,
        chunkCount: existing.rows[0]?.total ?? 0,
      });

      indexed = true;

      return {
        status: "unchanged",
        documentId,
        chunkCount: Number(existing.rows[0]?.total ?? 0),
        embeddedChunkCount: 0,
        contentHash,
      };
    }

    const chunks = chunkText(text, { minTokens: 5 });
    if (chunks.length === 0) {
      throw new IngestionValidationError(
        "Document did not produce any indexable chunks"
      );
    }

    const embeddingResults = await embedTexts(
      chunks.map((chunk) => chunk.content)
    );
    const config = getEmbeddingConfig();

    await updateDocumentContent(documentId, organizationId, text, contentHash);

    const stored = await replaceSourceIndex({
      organizationId,
      sourceType: "document",
      sourceId: documentId,
      sourceCreatedAt: document.created_at,
      chunks: chunks.map((chunk) => ({
        index: chunk.index,
        content: chunk.content,
        chunkHash: hashContent(chunk.content),
        metadata: {
          sourceType: "document",
          sourceId: documentId,
          tokenCount: chunk.tokenCount,
          charCount: chunk.charCount,
        },
      })),
      embeddings: embeddingResults.map((result) => result.embedding),
      config,
    });

    await updateDocumentProcessingStatus(
      documentId,
      organizationId,
      "processed"
    );

    logger.info("ingestion.document_indexed", {
      organizationId,
      documentId,
      chunkCount: stored,
      embeddingModel: config.model,
    });

    indexed = true;

    return {
      status: "indexed",
      documentId,
      chunkCount: stored,
      embeddedChunkCount: chunks.length,
      contentHash,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Document indexing failed";

    logger.error("ingestion.document_failed", {
      organizationId,
      documentId,
      error,
    });

    try {
      await updateDocumentProcessingStatus(
        documentId,
        organizationId,
        "failed",
        message
      );
    } catch (statusError) {
      logger.error("ingestion.document_status_update_failed", {
        organizationId,
        documentId,
        error: statusError,
      });
    }

    throw error;
  } finally {
    // The original is deleted when its text has been extracted, or when the
    // caller says this was the last attempt. It used to be deleted even when
    // BullMQ was going to retry, so the retry failed with "Uploaded file could
    // not be found" and that misleading message replaced the real cause on the
    // document row.
    if (input.filePath && (indexed || input.deleteFileAfter !== false)) {
      await removeUploadedFile(input.filePath);
    }
  }
}
