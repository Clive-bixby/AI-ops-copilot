/**
 * Largest document the API accepts, in bytes. Shared by the upload middleware
 * (which rejects oversized requests at the edge) and the parser (which checks
 * the file it is about to read), so the two cannot disagree.
 */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/**
 * Largest batch of log entries or tickets a single request may ingest.
 *
 * The JSON body limit alone does not bound row count: 1 MB of short log lines
 * is tens of thousands of rows, one embedding job per log group, and a
 * multi-row INSERT built from them. A batch is a bulk import, not a stream, so
 * it has an explicit ceiling and a 400 that names it.
 */
export const MAX_INGEST_BATCH_ENTRIES = 500;
