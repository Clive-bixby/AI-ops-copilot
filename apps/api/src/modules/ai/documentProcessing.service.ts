import fs from "fs/promises";

import { chunkText } from "./chunk.service.js";
import { generateEmbeddings } from "./embedding.service.js";
import { parseDocument } from "./documentParser.service.js";
import { insertChunks } from "./vector.service.js";
import {
  updateDocumentContent,
  updateDocumentProcessingStatus,
} from "../documents/documents.service.js";

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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Delete an uploaded original. Originals are only needed until their text has
 * been extracted; keeping them forever leaks disk space and retains user data
 * the system no longer needs.
 */
export async function removeUploadedFile(filePath: string): Promise<void> {
  const target = (filePath || "").trim();
  if (!target) {
    return;
  }

  try {
    await fs.unlink(target);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";

    if (code !== "ENOENT") {
      console.warn("Failed to delete uploaded file", { filePath: target, error });
    }
  }
}

async function generateEmbeddingsWithRetry(texts: string[]) {
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await generateEmbeddings(texts);
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }

      console.warn("Embedding batch failed; retrying", {
        attempt,
        totalInputs: texts.length,
        error,
      });
      await wait(500);
    }
  }

  throw new DocumentProcessingError("Embedding generation failed");
}

async function markDocumentFailedSafely(
  documentId: string,
  organizationId: string,
  message: string
): Promise<void> {
  try {
    await updateDocumentProcessingStatus(
      documentId,
      organizationId,
      "failed",
      message
    );
  } catch (statusError) {
    console.error("Failed to mark document processing as failed", {
      documentId,
      organizationId,
      error: statusError,
    });
  }
}

/**
 * Parse, chunk and embed an uploaded document.
 *
 * Failures are recorded on the document row and then rethrown so the caller can
 * report them. They are never converted into a success result. The uploaded
 * original is always deleted, whether processing succeeded or not.
 */
export async function processDocument(
  documentId: string,
  filePath: string,
  organizationId: string
): Promise<DocumentProcessingResult> {
  try {
    console.log("Parsing started", { documentId, organizationId });

    await updateDocumentProcessingStatus(
      documentId,
      organizationId,
      "processing"
    );

    const text = await parseDocument(filePath);
    await updateDocumentContent(documentId, organizationId, text);

    const chunks = chunkText(text, { minTokens: 5 });
    console.log("Chunks created", { documentId, count: chunks.length });

    if (chunks.length === 0) {
      throw new DocumentProcessingError("Document did not produce any chunks");
    }

    const embeddingResults = await generateEmbeddingsWithRetry(
      chunks.map((chunk) => chunk.content)
    );
    console.log("Embeddings generated", {
      documentId,
      count: embeddingResults.length,
    });

    const storedChunks = await insertChunks(
      chunks.map((chunk) => ({
        content: chunk.content,
        index: chunk.index,
        metadata: {
          sourceType: "document",
          sourceId: documentId,
          chunkHash: chunk.hash,
          tokenCount: chunk.tokenCount,
          charCount: chunk.charCount,
        },
      })),
      embeddingResults.map((result) => result.embedding),
      documentId,
      organizationId
    );

    await updateDocumentProcessingStatus(
      documentId,
      organizationId,
      "processed"
    );
    console.log("Vectors stored", {
      documentId,
      count: storedChunks.length,
    });

    return { status: "processed", totalChunks: storedChunks.length };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Document processing failed";

    console.error("Document processing failed", {
      documentId,
      organizationId,
      error,
    });

    await markDocumentFailedSafely(documentId, organizationId, message);

    throw error;
  } finally {
    await removeUploadedFile(filePath);
  }
}
