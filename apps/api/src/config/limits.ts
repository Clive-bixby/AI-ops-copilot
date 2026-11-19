/**
 * Largest document the API accepts, in bytes. Shared by the upload middleware
 * (which rejects oversized requests at the edge) and the parser (which checks
 * the file it is about to read), so the two cannot disagree.
 */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
