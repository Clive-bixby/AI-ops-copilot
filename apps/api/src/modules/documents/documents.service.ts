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
};

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
      id,
      filename,
      processing_status,
      processing_error,
      processed_at,
      created_at
    FROM documents
    WHERE organization_id = $1
    ORDER BY created_at DESC
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
  }));
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
