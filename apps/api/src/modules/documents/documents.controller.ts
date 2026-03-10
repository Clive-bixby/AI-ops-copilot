import type { Request, Response } from "express";

import {
  createDocument,
  DocumentsValidationError,
  listDocuments,
} from "./documents.service.js";

export async function createDocumentController(req: Request, res: Response) {
  try {
    const organizationId = req.organizationId;
    const file = req.file;

    if (!organizationId) {
      return res.status(400).json({ error: "Organization ID is required" });
    }

    if (!file) {
      return res.status(400).json({ error: "File is required" });
    }

    const result = await createDocument({
      organizationId,
      filename: file.filename,
    });

    return res.status(201).json(result);
  } catch (error) {
    if (error instanceof DocumentsValidationError) {
      return res.status(400).json({ error: error.message });
    }

    const unknownError =
      error instanceof Error ? error : new Error("Unknown error");
    console.error("Create document failed:", unknownError);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function listDocumentsController(req: Request, res: Response) {
  try {
    const organizationId = req.organizationId;

    if (!organizationId) {
      return res.status(400).json({ error: "Organization ID is required" });
    }

    const result = await listDocuments(organizationId);
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof DocumentsValidationError) {
      return res.status(400).json({ error: error.message });
    }

    const unknownError =
      error instanceof Error ? error : new Error("Unknown error");
    console.error("List documents failed:", unknownError);
    return res.status(500).json({ error: "Internal server error" });
  }
}
