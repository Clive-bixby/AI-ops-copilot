# Day 4 Postman Tests

This folder contains a ready Postman setup for testing the Day 4 synchronous document pipeline:

`upload -> parse -> chunk -> batch embed -> vector store -> semantic search`

## Files

- `day4.postman_environment.json`
- `day4.postman_collection.json`

## Import Steps

1. Open Postman.
2. Click `Import`.
3. Import both files in this folder.
4. Select environment `AI Ops Local`.

## Before Running

1. Start API server on `http://localhost:5000`.
2. Ensure Supabase migration for document processing fields is applied.
3. Ensure Ollama is running with model matching `VECTOR(768)` (for example `nomic-embed-text`).

## Request Order

Run requests in this sequence:

1. `01 - AI Health`
2. `02 - Register`
3. `03 - Login (Optional)`
4. `04 - Upload Document (.txt or .pdf)` - select local file in form-data key `file`
5. `05 - List Documents`
6. `06 - Vector Search`
7. `07 - Upload Unsupported File (.csv)` - select local `.csv`
8. `08 - Tenant Check (Missing Org Header)`
9. `09 - Tenant Check (Wrong Org Header)`

## Notes

- The `Register` test script stores `token` and `organizationId` automatically.
- `Login` refreshes `token`, but `organizationId` remains from Register (expected for current backend token shape).
- Upload requests are designed to return `201` even when processing fails, with failure surfaced under `processing`.
- Each request includes tests so Postman shows pass/fail directly in the runner.
