import fs from "fs/promises";
import path from "path";

import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import { DocumentParserError } from "../ai/documentParser.service.js";
import { DocumentProcessingError } from "../ai/documentProcessing.service.js";
import {
  EmbeddingConnectionError,
  EmbeddingModelError,
  EmbeddingValidationError,
} from "../ai/embedding.service.js";
import { VectorValidationError } from "../ai/vector.service.js";
import { IngestionError } from "../ingestion/errors.js";
import { hashFileBytes } from "../ingestion/embeddingConfig.js";
import { runIdempotent } from "../ingestion/idempotency.service.js";
import {
  enqueueIngestionJob,
  QueueUnavailableError,
} from "../ingestion/jobQueue.js";
import {
  createDocument,
  deleteDocument,
  getDocumentDetail,
  listDocuments,
  updateDocumentProcessingStatus,
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
  IngestionError,
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

  // Hash the original bytes before parsing: identical uploads are rejected
  // before any parsing or embedding work is spent on them, and the hash is also
  // the request fingerprint for Idempotency-Key replays.
  let fileHash: string;
  try {
    fileHash = hashFileBytes(await fs.readFile(file.path));
  } catch (error) {
    await removeUploadedFileSafely(file.path);
    throw error;
  }

  try {
    const result = await runIdempotent({
      organizationId,
      endpoint: "documents.upload",
      key: req.header("idempotency-key"),
      requestHash: fileHash,
      handler: async () => {
        const document = await createDocument({
          organizationId,
          filename: file.originalname || file.filename,
          fileHash,
        });

        if (document.duplicate) {
          await removeUploadedFileSafely(file.path);

          // The duplicate is already indexed. Report what actually exists
          // instead of implying that nothing was stored.
          const existing = await getDocumentDetail(
            organizationId,
            document.id
          );

          return {
            status: 200,
            body: {
              id: document.id,
              filename: document.filename,
              createdAt: document.createdAt,
              duplicate: true,
              processing: {
                status: existing?.processingStatus ?? "pending",
                totalChunks: existing?.chunkCount ?? 0,
              },
            },
          };
        }

        try {
          await enqueueIngestionJob({
            organizationId,
            sourceType: "document",
            sourceId: document.id,
            // Both containers mount the uploads volume at the same path, so
            // the worker can parse the file the API received.
            filePath: path.resolve(file.path),
          });
        } catch (error) {
          await removeUploadedFileSafely(file.path);

          if (error instanceof QueueUnavailableError) {
            await updateDocumentProcessingStatus(
              document.id,
              organizationId,
              "failed",
              "Ingestion queue is unavailable"
            ).catch(() => undefined);

            return {
              status: 503,
              body: {
                error:
                  "Document was stored but could not be queued for indexing. Retry the upload.",
                documentId: document.id,
              },
            };
          }

          throw error;
        }

        return {
          status: 202,
          body: { ...document, processing: { status: "queued" } },
        };
      },
    });

    if (result.replayed) {
      // A replayed request must not leave its freshly uploaded file on disk.
      await removeUploadedFileSafely(file.path);
      res.set("Idempotency-Replayed", "true");
    }

    return res.status(result.status).json(result.body);
  } catch (error) {
    await removeUploadedFileSafely(file.path);
    throw error;
  }
});

async function removeUploadedFileSafely(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";

    if (code !== "ENOENT") {
      console.warn("Failed to delete uploaded file", { filePath, error });
    }
  }
}

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

export const reprocessDocumentController = asyncHandler(async (req, res) => {
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

  const result = await enqueueIngestionJob({
    organizationId,
    sourceType: "document",
    sourceId: documentId,
  });

  return res.status(202).json({
    documentId,
    jobId: result.job.id,
    status: result.job.status,
    deduplicated: !result.created,
  });
});

export const deleteDocumentController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;

  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const rawId = req.params.id;
  const documentId = Array.isArray(rawId) ? rawId[0] ?? "" : rawId ?? "";

  const deleted = await deleteDocument(organizationId, documentId);
  if (!deleted) {
    throw createHttpError(404, "Document not found");
  }

  return res.status(204).send();
});
