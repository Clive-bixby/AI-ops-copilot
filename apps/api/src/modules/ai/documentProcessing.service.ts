import {
  indexDocument,
  removeUploadedFile,
} from "../ingestion/documentIngest.service.js";

export type DocumentProcessingStatus = "processed" | "failed";

export type DocumentProcessingResult = {
  status: DocumentProcessingStatus;
  totalChunks: number;
  error?: string;
};

export class DocumentProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentProcessingError";
  }
}

export { removeUploadedFile };

/**
 * Parse, chunk and embed an uploaded document.
 *
 * Delegates to the same ingestion core the queue worker uses, so synchronous
 * uploads and background jobs cannot diverge in chunking, embedding or index
 * replacement behaviour. Failures are recorded on the document row and
 * rethrown; the uploaded original is always deleted.
 */
export async function processDocument(
  documentId: string,
  filePath: string,
  organizationId: string
): Promise<DocumentProcessingResult> {
  const result = await indexDocument({
    documentId,
    filePath,
    organizationId,
    deleteFileAfter: true,
  });

  return { status: "processed", totalChunks: result.chunkCount };
}
