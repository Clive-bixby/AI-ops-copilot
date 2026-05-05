import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import { processDocument } from "../ai/documentProcessing.service.js";
import { createDocument, listDocuments } from "./documents.service.js";

export const createDocumentController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const file = req.file;

  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  if (!file) {
    throw createHttpError(400, "File is required");
  }

  console.log("Document received", {
    organizationId,
    filename: file.originalname,
    storedAs: file.filename,
  });

  const document = await createDocument({
    organizationId,
    filename: file.originalname || file.filename,
  });

  const processing = await processDocument(
    document.id,
    file.path,
    organizationId
  );

  return res.status(201).json({
    ...document,
    processing,
  });
});

export const listDocumentsController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;

  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const result = await listDocuments(organizationId);
  return res.status(200).json(result);
});
