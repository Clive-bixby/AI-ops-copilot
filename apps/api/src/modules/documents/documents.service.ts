import { pool } from "../../core/db.js";

export type CreateDocumentInput = {
  organizationId: string;
  filename: string;
  content?: string;
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

export async function createDocument(input: CreateDocumentInput) {
  const organizationId = (input.organizationId || "").trim();
  const filename = (input.filename || "").trim();
  const content = input.content ?? "";

  if (!organizationId) {
    throw new DocumentsValidationError("Organization ID is required");
  }

  if (!filename) {
    throw new DocumentsValidationError("Filename is required");
  }

  const result = await pool.query<DocumentRow>(
    `
    INSERT INTO documents (organization_id, filename, content)
    VALUES ($1, $2, $3)
    RETURNING id, filename, created_at
    `,
    [organizationId, filename, content]
  );

  const document = result.rows[0];
  if (!document) {
    throw new Error("Failed to create document");
  }

  return {
    id: document.id,
    filename: document.filename,
    createdAt: document.created_at,
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
      COUNT(dc.id)::int AS chunk_count
    FROM documents d
    LEFT JOIN document_chunks dc ON dc.document_id = d.id
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
       FROM document_chunks
       WHERE document_id = $1 AND organization_id = $2
       ORDER BY chunk_index ASC
       LIMIT 50`,
      [docId, orgId]
    ),
    pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM document_chunks
       WHERE document_id = $1 AND organization_id = $2`,
      [docId, orgId]
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

export async function updateDocumentContent(
  documentId: string,
  organizationId: string,
  content: string
) {
  const docId = (documentId || "").trim();
  const orgId = (organizationId || "").trim();

  if (!docId) {
    throw new DocumentsValidationError("Document ID is required");
  }

  if (!orgId) {
    throw new DocumentsValidationError("Organization ID is required");
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
