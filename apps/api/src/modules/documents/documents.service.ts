import { pool } from "../../core/db.js";

export type CreateDocumentInput = {
  organizationId: string;
  filename: string;
  content?: string;
  /** md5 of the original file bytes, used to reject duplicate uploads. */
  fileHash?: string;
};

export type DocumentProcessingStatus =
  | "pending"
  | "processing"
  | "processed"
  | "failed";

type DocumentRow = {
  id: string;
  filename: string;
  processing_status?: DocumentProcessingStatus;
  processing_error?: string | null;
  processed_at?: string | null;
  created_at: string;
  chunk_count?: number;
};

type DocumentChunkRow = {
  id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DocumentsValidationError extends Error {}

/**
 * Create a document row, or return the existing one when the same bytes were
 * already uploaded to this organization.
 *
 * Deduplication is enforced by the partial unique index
 * `documents_org_file_hash_uniq`, so two concurrent identical uploads cannot
 * both create a document. Returning the stored document is honest: the content
 * is already indexed, and the caller should not process or embed it again.
 */
export async function createDocument(input: CreateDocumentInput) {
  const organizationId = (input.organizationId || "").trim();
  const filename = (input.filename || "").trim();
  const content = input.content ?? "";
  const fileHash = input.fileHash?.trim() || null;

  if (!organizationId) {
    throw new DocumentsValidationError("Organization ID is required");
  }

  if (!filename) {
    throw new DocumentsValidationError("Filename is required");
  }

  const result = await pool.query<DocumentRow>(
    `
    INSERT INTO documents (organization_id, filename, content, file_hash)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (organization_id, file_hash) WHERE file_hash IS NOT NULL
    DO NOTHING
    RETURNING id, filename, created_at
    `,
    [organizationId, filename, content, fileHash]
  );

  const inserted = result.rows[0];
  if (inserted) {
    return {
      id: inserted.id,
      filename: inserted.filename,
      createdAt: inserted.created_at,
      duplicate: false,
    };
  }

  const existing = await pool.query<DocumentRow>(
    `SELECT id, filename, created_at
     FROM documents
     WHERE organization_id = $1 AND file_hash = $2`,
    [organizationId, fileHash]
  );

  const document = existing.rows[0];
  if (!document) {
    throw new Error("Failed to create document");
  }

  return {
    id: document.id,
    filename: document.filename,
    createdAt: document.created_at,
    duplicate: true,
  };
}

export async function listDocuments(organizationId: string) {
  const orgId = (organizationId || "").trim();

  if (!orgId) {
    throw new DocumentsValidationError("Organization ID is required");
  }

  const result = await pool.query<DocumentRow>(
    `
    SELECT
      d.id,
      d.filename,
      d.processing_status,
      d.processing_error,
      d.processed_at,
      d.created_at,
      COUNT(sc.id)::int AS chunk_count
    FROM documents d
    LEFT JOIN source_chunks sc
      ON sc.organization_id = d.organization_id
     AND sc.source_type = 'document'
     AND sc.source_id = d.id
    WHERE d.organization_id = $1
    GROUP BY d.id
    ORDER BY d.created_at DESC
    `,
    [orgId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    processingStatus: row.processing_status,
    processingError: row.processing_error,
    processedAt: row.processed_at,
    createdAt: row.created_at,
    chunkCount: Number(row.chunk_count ?? 0),
  }));
}

export async function getDocumentDetail(
  organizationId: string,
  documentId: string
) {
  const orgId = (organizationId || "").trim();
  const docId = (documentId || "").trim();

  if (!orgId) {
    throw new DocumentsValidationError("Organization ID is required");
  }

  if (!docId || !UUID_REGEX.test(docId)) {
    throw new DocumentsValidationError("A valid document ID is required");
  }

  const documentResult = await pool.query<DocumentRow>(
    `SELECT
       id,
       filename,
       processing_status,
       processing_error,
       processed_at,
       created_at
     FROM documents
     WHERE id = $1 AND organization_id = $2`,
    [docId, orgId]
  );

  const document = documentResult.rows[0];
  if (!document) {
    return null;
  }

  const [chunksResult, chunkCountResult] = await Promise.all([
    pool.query<DocumentChunkRow>(
      `SELECT id, chunk_index, content, metadata, created_at
       FROM source_chunks
       WHERE organization_id = $1 AND source_type = 'document' AND source_id = $2
       ORDER BY chunk_index ASC
       LIMIT 50`,
      [orgId, docId]
    ),
    pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM source_chunks
       WHERE organization_id = $1 AND source_type = 'document' AND source_id = $2`,
      [orgId, docId]
    ),
  ]);

  return {
    id: document.id,
    filename: document.filename,
    processingStatus: document.processing_status,
    processingError: document.processing_error,
    processedAt: document.processed_at,
    createdAt: document.created_at,
    chunkCount: Number(chunkCountResult.rows[0]?.total ?? 0),
    chunks: chunksResult.rows.map((chunk) => ({
      id: chunk.id,
      chunkIndex: chunk.chunk_index,
      preview:
        chunk.content.length > 400
          ? `${chunk.content.slice(0, 400).trim()}...`
          : chunk.content,
      metadata: chunk.metadata,
      createdAt: chunk.created_at,
    })),
  };
}

export type ReprocessReadiness = "ready" | "pending" | "missing_source";

/**
 * Can this document be indexed again from what is stored?
 *
 * Reprocessing does not re-upload anything: it re-reads the document's extracted
 * text. The uploaded original is deleted once its text has been extracted (or
 * when the last attempt fails), so a document with no stored text can only be
 * indexed again after the file is uploaded again. Answering 202 there produced a
 * job that was guaranteed to fail with "Document has no extracted text", long
 * after the user could connect it to their click.
 *
 * An active job means the file may still be on disk and about to be parsed, so
 * that case is not refused.
 */
export async function describeReprocessReadiness(
  organizationId: string,
  documentId: string
): Promise<ReprocessReadiness | null> {
  const orgId = (organizationId || "").trim();
  const docId = (documentId || "").trim();

  if (!orgId || !docId || !UUID_REGEX.test(docId)) {
    return null;
  }

  const result = await pool.query<{ has_text: boolean; active_job: boolean }>(
    `SELECT btrim(COALESCE(d.content, '')) <> '' AS has_text,
            EXISTS (
              SELECT 1
              FROM ingestion_jobs j
              WHERE j.organization_id = d.organization_id
                AND j.source_type = 'document'
                AND j.source_id = d.id
                AND j.status IN ('queued', 'running')
            ) AS active_job
     FROM documents d
     WHERE d.id = $1 AND d.organization_id = $2`,
    [docId, orgId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  if (row.has_text) {
    return "ready";
  }

  return row.active_job ? "pending" : "missing_source";
}

export async function deleteDocument(
  organizationId: string,
  documentId: string
): Promise<boolean> {
  const orgId = (organizationId || "").trim();
  const docId = (documentId || "").trim();

  if (!orgId) {
    throw new DocumentsValidationError("Organization ID is required");
  }

  if (!docId || !UUID_REGEX.test(docId)) {
    throw new DocumentsValidationError("A valid document ID is required");
  }

  // Indexed chunks are removed by the documents_delete_source_chunks trigger.
  const result = await pool.query(
    `DELETE FROM documents WHERE id = $1 AND organization_id = $2`,
    [docId, orgId]
  );

  return (result.rowCount ?? 0) > 0;
}

export async function updateDocumentContent(
  documentId: string,
  organizationId: string,
  content: string,
  contentHash?: string
) {
  const docId = (documentId || "").trim();
  const orgId = (organizationId || "").trim();

  if (!docId) {
    throw new DocumentsValidationError("Document ID is required");
  }

  if (!orgId) {
    throw new DocumentsValidationError("Organization ID is required");
  }

  if (contentHash !== undefined) {
    await pool.query(
      `
      UPDATE documents
      SET content = $3, content_hash = $4
      WHERE id = $1 AND organization_id = $2
      `,
      [docId, orgId, content, contentHash]
    );

    return;
  }

  await pool.query(
    `
    UPDATE documents
    SET content = $3
    WHERE id = $1 AND organization_id = $2
    `,
    [docId, orgId, content]
  );
}

export async function updateDocumentProcessingStatus(
  documentId: string,
  organizationId: string,
  status: DocumentProcessingStatus,
  errorMessage?: string
) {
  const docId = (documentId || "").trim();
  const orgId = (organizationId || "").trim();

  if (!docId) {
    throw new DocumentsValidationError("Document ID is required");
  }

  if (!orgId) {
    throw new DocumentsValidationError("Organization ID is required");
  }

  const allowedStatuses: DocumentProcessingStatus[] = [
    "pending",
    "processing",
    "processed",
    "failed",
  ];

  if (!allowedStatuses.includes(status)) {
    throw new DocumentsValidationError("Invalid document processing status");
  }

  await pool.query(
    `
    UPDATE documents
    SET
      processing_status = $3,
      processing_error = $4,
      processed_at = CASE WHEN $3 = 'processed' THEN NOW() ELSE NULL END
    WHERE id = $1 AND organization_id = $2
    `,
    [docId, orgId, status, errorMessage ?? null]
  );
}
