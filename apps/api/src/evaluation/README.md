# Investigation evaluation

`npm run eval:investigations` seeds a labelled corpus through the production
ingestion path, runs real evidence collection for each case, and checks what an
engineer would see. `--breakdown` prints every selected source with the rule that
admitted it, and `--keep` leaves the corpus in place for inspection.

## What CI verifies

The `api-eval` job runs the harness against a real PostgreSQL 16 + pgvector
service, with migrations applied, so it exercises the actual retrieval SQL:
vector search, full-text search, fusion, time-window filtering, source
resolution, grading, the evidence budget and idempotent writes.

Embeddings are deterministic in CI. `embeddingFixtureServer.ts` replays vectors
recorded once from `nomic-embed-text` for exactly the texts the evaluation
embeds; it is not a hash-based fake, so cosine similarity is the real model's.
A text that is not in `embeddingFixtures.json` makes the stub return 503 and the
job fail, so the corpus cannot silently drift away from its fixture.

Evidence evaluation is deterministic and gated: recall, precision, grading
accuracy, duplicate sources, forbidden sources, the no-evidence case and the
windowed case's bounds/labels/ordering must all pass. A failing threshold exits
non-zero and fails the workflow.

Re-record the fixture after changing the corpus or the embedding model:

```bash
npm run embed:fixture -- --record        # needs a local Ollama
npm run eval:investigations              # writes embeddingFixtures.json
```

## What CI does not verify

- Analysis and follow-up answers: they call a language model, are not
  repeatable, and are not part of the harness. CI never uses a paid API key.
- The HTTP layer, authentication, tenant isolation of the API routes, and the
  web application: those are covered by their own tests and manual checks.
- Real Ollama behaviour or other embedding models: replay proves the collection
  code, not the model runtime.
