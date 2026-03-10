import { pool } from "../../core/db.js";

export type CreateDocumentInput = {
  organizationId: string;
  filename: string;
};

type DocumentRow = {
  id: string;
  filename: string;
  created_at: string;
};

export class DocumentsValidationError extends Error {}

export async function createDocument(input: CreateDocumentInput) {
  const organizationId = (input.organizationId || "").trim();
  const filename = (input.filename || "").trim();

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
    [organizationId, filename, ""]
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
    SELECT id, filename, created_at
    FROM documents
    WHERE organization_id = $1
    ORDER BY created_at DESC
    `,
    [orgId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    createdAt: row.created_at,
  }));
}
