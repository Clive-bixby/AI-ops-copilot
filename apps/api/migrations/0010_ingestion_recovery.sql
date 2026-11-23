-- 0010_ingestion_recovery.sql
--
-- Recovery needs one fact the ledger did not keep: where the uploaded original
-- was on disk.
--
-- A document job parses the file the API received. After a crash, requeueing
-- the job without that path made `indexDocument` fall back to the document's
-- stored text -- which is empty, because the crash happened before extraction.
-- The recovered job then failed with "Document has no extracted text to index"
-- and the uploaded original was left behind as an orphan file nobody could use.
--
-- The path is a pointer to a temp file, not durable content: the recovery sweep
-- checks that the file still exists before handing the job back to the queue.

ALTER TABLE ingestion_jobs
    ADD COLUMN IF NOT EXISTS file_path TEXT;

COMMENT ON COLUMN ingestion_jobs.file_path IS
    'Uploaded original for a document job, shared by the api and worker containers. Temporary: deleted after the text is extracted, and re-checked before a recovered job is requeued.';
