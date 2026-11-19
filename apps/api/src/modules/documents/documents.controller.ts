import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import { DocumentParserError } from "../ai/documentParser.service.js";
import {
  DocumentProcessingError,
  processDocument,
  removeUploadedFile,
} from "../ai/documentProcessing.service.js";
import {
  EmbeddingConnectionError,
  EmbeddingModelError,
  EmbeddingValidationError,
} from "../ai/embedding.service.js";
import { VectorValidationError } from "../ai/vector.service.js";
import {
  createDocument,
  getDocumentDetail,
  listDocuments,
} from "./documents.service.js";

/**
 * Errors that mean "the file was stored but could not be turned into knowledge".
 * They are reported as 422 with the real reason. Anything else is a server
 * fault and is passed to the error middleware.
 */
const PROCESSING_FAILURE_ERRORS = [
  DocumentParserError,
  DocumentProcessingError,
  EmbeddingValidationError,
  EmbeddingConnectionError,
  EmbeddingModelError,
  VectorValidationError,
] as const;

function isProcessingFailure(error: unknown): boolean {
  return PROCESSING_FAILURE_ERRORS.some(
    (ErrorType) => error instanceof ErrorType
  );
}

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

  let document: Awaited<ReturnType<typeof createDocument>>;

  try {
    document = await createDocument({
      organizationId,
      filename: file.originalname || file.filename,
    });
  } catch (error) {
    // The upload is on disk but no document row will ever process it.
    await removeUploadedFile(file.path);
    throw error;
  }

  try {
    const processing = await processDocument(
      document.id,
      file.path,
      organizationId
    );

    return res.status(201).json({
      ...document,
      processing,
    });
  } catch (error) {
    if (!isProcessingFailure(error)) {
      throw error;
    }

    // The document row exists and is marked failed. Say so instead of
    // returning 201 for work that did not happen.
    const message =
      error instanceof Error ? error.message : "Document processing failed";

    return res.status(422).json({
      error: `Document processing failed: ${message}`,
      documentId: document.id,
      filename: document.filename,
      createdAt: document.createdAt,
      processing: {
        status: "failed",
        totalChunks: 0,
        error: message,
      },
    });
  }
});

export const listDocumentsController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;

  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const result = await listDocuments(organizationId);
  return res.status(200).json(result);
});

export const getDocumentController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;

  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const rawId = req.params.id;
  const documentId = Array.isArray(rawId) ? rawId[0] ?? "" : rawId ?? "";

  const document = await getDocumentDetail(organizationId, documentId);

  if (!document) {
    throw createHttpError(404, "Document not found");
  }

  return res.status(200).json(document);
});
