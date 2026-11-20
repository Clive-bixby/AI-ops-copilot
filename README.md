# OpsPilot AI

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-BullMQ-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

**OpsPilot AI** is an AI operations copilot that ingests logs, tickets, and internal documents and answers operational questions with grounded, cited LLM responses.

## Why it stands out
- **End-to-end RAG** — ingestion → chunking → embeddings → pgvector retrieval → cited answers
- **Multi-tenant backend** — JWT auth, org scoping, RBAC, per-organization isolation
- **Observability-first UI** — React dashboard, log stream, ticket matrix, document vault, copilot chat

## Architecture
```
apps/
  api/   Express + TypeScript (RAG, ingestion, auth, RBAC)
  web/   React + Vite + Tailwind (dashboard, copilot, logs, tickets, docs)
infra: PostgreSQL (pgvector) + Redis + Docker Compose
```

## Feature highlights
- **RAG Q&A** with citations, confidence scoring, and a "no reliable context" answer
- **Document ingestion** (PDF/TXT/CSV/MD/JSON/LOG) with chunking + embeddings
- **Log pipeline** — ingest, parse, filter
- **Ticket pipeline** — ingest (JSON/CSV), triage, matrix view
- **Hybrid retrieval** over documents, tickets and grouped logs — pgvector cosine fused with Postgres full-text by reciprocal rank fusion; `/ai/search` reports `matchType` (`vector` / `keyword` / `hybrid`), a cosine `similarity` (null when only keywords matched) and an RRF `score`
- **Admin panel** with role-gated access
- **Dockerized** services with health checks

## Tech stack
| Layer | Tech |
|---|---|
| Frontend | React 19, Vite, Tailwind, React Router |
| Backend | Node.js, Express 5, TypeScript |
| AI | Gemini for generation, Ollama (`nomic-embed-text`) for embeddings, pgvector cosine + Postgres full-text retrieval fused with RRF |
| Data | PostgreSQL + pgvector |
| Queue | Redis + BullMQ (ingestion jobs are queued and drained by the `worker` service) |
| Auth | JWT, org scoping, RBAC |
| DevOps | Docker, Docker Compose |

## Quick start (local, without Docker)

Requirements: Node 22+, PostgreSQL 16 with the `vector` extension, and Ollama with `nomic-embed-text` pulled.

```bash
# 1. Install (done per app; there is no workspace root install)
cd apps/api && npm install
cd ../web && npm install

# 2. Configure
cp apps/api/.env.example apps/api/.env     # set DATABASE_URL, JWT_SECRET, GEMINI_API_KEY
cp apps/web/.env.example apps/web/.env     # VITE_API_URL, e.g. http://localhost:5000

# 3. Create the schema
cd apps/api && npm run db:migrate

# 4. Run
cd apps/api && npm run dev                 # http://localhost:3000
cd apps/web && npm run dev                 # http://localhost:5173
```

If your database already has the tables from the old manual `schema.sql`
import, run `npm run db:baseline` once instead of `db:migrate`. It records the
existing migrations as applied without touching your data.

## Quick start (Docker)

```bash
cp .env.example .env      # optional: override credentials, tokens, API URL
docker compose up --build
```

| Service | URL |
|---|---|
| Web | http://localhost:4173 |
| API | http://localhost:3000 |
| API health | http://localhost:3000/health |

The `migrate` job runs the database migrations and must finish before the API
starts. Ollama is expected on the host at `host.docker.internal:11434`; set
`OLLAMA_URL` if it lives elsewhere. Without Ollama the API still starts, and
`/ai/health` reports embeddings as unavailable — document ingestion and search
fail with an explicit error rather than a fake success.

Host ports are configurable (`POSTGRES_PORT`, `REDIS_PORT`, `API_PORT`,
`WEB_PORT`) so the stack can run beside another local Postgres or frontend. If
you change `API_PORT`, set `VITE_API_URL` to match — it is baked into the web
bundle at build time, so rebuild the web image afterwards.

Compose defaults (database password, `JWT_SECRET`) are placeholders for local
use. Set real values in `.env` before putting the stack anywhere shared.

## Database migrations

`apps/api/migrations/*.sql` is the single source of truth for the schema and is
applied in filename order by `apps/api/src/scripts/migrate.ts`. Every applied
file is recorded in `schema_migrations` with a checksum; editing an applied
migration is rejected, so schema changes always arrive as a new file.

```bash
cd apps/api
npm run db:migrate     # apply pending migrations
npm run db:baseline    # mark an existing database as migrated without running SQL
npm run typecheck      # tsc --noEmit
npm test               # node:test unit tests, no database needed
```

`.github/workflows/ci.yml` runs the API typecheck and unit tests plus the web
typecheck and production build on every push to `main` and every pull request.

## Retrieval

One index (`source_chunks`) holds every searchable source: document chunks, tickets and grouped log events. Two arms query it and are fused by reciprocal rank fusion (`k=60`):

- **Vector arm** — cosine distance over pgvector, filtered to the embedding model and width recorded on each row, with a similarity floor (`AI_SEARCH_MIN_SIMILARITY`, default 0.65).
- **Full-text arm** — Postgres `tsvector` with the `english` configuration. It ORs the query lexemes (so a question can add words the runbook does not use) and ranks with `ts_rank_cd`.

`POST /ai/search`:

```jsonc
{
  "query": "how do I roll back a bad deployment",
  "limit": 5,                    // 1-10
  "mode": "hybrid",              // "vector" reproduces the pre-fusion behaviour
  "sourceTypes": ["document"]    // optional: "document" | "ticket" | "log"
}
```

Each result carries `matchType`, `similarity` (null for keyword-only hits, never invented), the RRF `score`, the real `sourceType`/`sourceId` and a `preview`. Hybrid evidence keeps its cosine similarity while being labelled `hybrid`.

A chunk the vector arm returned always keeps its keyword evidence. A chunk only the keyword arm found competes for three of ten result slots, ordered by how many distinct query lexemes it covers and then by `ts_rank_cd`, so the permissive OR query cannot pad the tail. `HYBRID_RRF_K` overrides the fusion constant.

### Measuring retrieval quality

```bash
cd apps/api
npm run eval:retrieval                 # noisy corpus (default)
npm run eval:retrieval -- --small      # without the distractor documents
npm run eval:retrieval -- --keep       # keep the seeded organization for inspection
```

The harness seeds a temporary organization through the production ingestion path, runs every labelled query in both modes, prints Recall@5/10, Precision@5/10, MRR@10, nDCG@10 and per-page counts of keyword-only results (and how many were irrelevant), then deletes the organization. It needs Postgres with pgvector and Ollama; the absolute numbers depend on the corpus and the embedding model, so compare modes within one run rather than against values copied from another machine.

## Environment
- `apps/api/.env.example` — API, datastore, auth, Gemini and Ollama settings
- `apps/web/.env.example` — `VITE_API_URL` (inlined at build time)
- `.env.example` — the values `docker compose` reads

Never commit secrets. `node_modules/`, `.env`, build output and uploads are
gitignored.

## Project structure
```
apps/api
  migrations/  ordered SQL migrations (schema source of truth)
  src/core     db pool, queue
  src/modules  auth, documents, logs, tickets, ai, admin, insights
  src/middleware auth, org, upload, error
  src/scripts  migrate, baseline
apps/web/src
  pages/       Dashboard, Copilot, Logs, Tickets, Documents, Search, Admin, Settings
  components/  Layout, navigation, shared UI
```

## Security
- Secrets via environment variables; uploads and runtime data gitignored
- JWT auth with org-scoped RBAC; tenant id always derived from verified membership
- `helmet` security headers and `x-powered-by` disabled
- CORS is an explicit allowlist (`CORS_ORIGINS`); production defaults to no
  cross-origin browser access
- Per-IP rate limits: `RATE_LIMIT_MAX` per minute, stricter `AUTH_RATE_LIMIT_MAX`
  per 15 minutes on login/register
- JSON bodies capped by `JSON_BODY_LIMIT` (default 1 MB)
- `/ai/test-*` development routes answer 404 unless `ENABLE_DEV_ENDPOINTS=true`
- Uploads capped at 10 MB and restricted to parseable document types

## Author
Built by Aryan Yadav — [GitHub](https://github.com/Clive-bixby)
