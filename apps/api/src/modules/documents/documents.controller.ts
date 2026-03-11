import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
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

  const result = await createDocument({
    organizationId,
    filename: file.filename,
  });

  return res.status(201).json(result);
});

export const listDocumentsController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;

  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const result = await listDocuments(organizationId);
  return res.status(200).json(result);
});
