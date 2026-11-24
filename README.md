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
- **Investigations** — problem statement, real evidence collection, synchronous analysis, human-verified hypotheses, timeline and resolution, with ownership and a closed-record rule
- **Action items** — follow-up work attached to one investigation: assignee, priority, due date, blocked reason, reopen, and an append-only event history; analysis-derived items keep an immutable source label
- **Operational overview** — `/operations` counts investigations and follow-up work by status, ownership, overdue and due-soon, with a server-filtered cross-investigation action-item queue
- **Admin panel** with role-gated access
- **Dockerized** services with health checks

## Tech stack
| Layer | Tech |
|---|---|
| Frontend | React 19, Vite, Tailwind, React Router |
| Backend | Node.js, Express 5, TypeScript |
| AI | Gemini for generation; pluggable embeddings (Ollama, any OpenAI-compatible API, or recorded fixtures); pgvector cosine + Postgres full-text retrieval fused with RRF |
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
cp apps/web/.env.example apps/web/.env     # VITE_API_URL, e.g. http://localhost:3000

# 3. Create the schema
cd apps/api && npm run db:migrate

# 4. Run
cd apps/api && npm run dev                 # http://localhost:3000
cd apps/api && npm run worker              # drains queued ingestion jobs (separate terminal)
cd apps/web && npm run dev                 # http://localhost:5173
```

If your database already has the tables from the old manual `schema.sql`
import, run `npm run db:baseline` once instead of `db:migrate`. It records the
existing migrations as applied without touching your data.

## Quick start (Docker)

```bash
cp .env.example .env      # overrides for credentials, tokens, API URL
# The stack refuses a placeholder signing key. Set JWT_SECRET in .env:
#   openssl rand -hex 32
docker compose up --build
```

| Service | URL |
|---|---|
| Web | http://localhost:4173 |
| API | http://localhost:3000 |
| API liveness | http://localhost:3000/health |
| API readiness | http://localhost:3000/ready |
| Ingestion health | http://localhost:3000/ingestion/health |

The two probes answer different questions. `/health` is liveness and does no
I/O, so a platform cannot restart a running API because a dependency blinked.
`/ready` checks Postgres and returns `503` when it is unreachable; Redis is
reported in `checks.redis` but does not gate readiness, because only ingestion
needs it and gating would turn a Redis blip into a restart loop. The container
health check probes `/ready`. Add `HEALTH_DETAIL=true` to include the
underlying error in the response.

Ingestion has its own answer. `GET /ingestion/health` (auth +
`x-organization-id`) reports this tenant's job counts, how many are stuck past
the stale window, the Redis queue depth, and whether a worker is alive (a
heartbeat key with a 45 s TTL). A queue with waiting jobs says nothing about
whether anything is consuming it; `worker.status` does. The worker also sweeps
for jobs a crashed process left on `running` and requeues or fails them — see
[§14 of the deployment notes](docs/deployment.md#14-when-an-ingestion-job-dies-with-the-process).

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

## Demo data

A fresh deployment is empty, and an empty product demonstrates nothing. With the
API and the worker running:

```bash
node scripts/seed-demo.mjs                          # API at http://localhost:3000
API_URL=https://your-api node scripts/seed-demo.mjs # another deployment
```

It registers `demo@opspilot.dev` / `OpsPilot!Demo2026` in an organization called
"Northwind Ops (Demo)", uploads six runbooks, ingests 14 tickets and 32 log
events, and creates three investigations with action items in every state
(completed, in progress, blocked and overdue). Every row goes through the
production ingestion path, so the worker parses, chunks and embeds the documents
instead of inserting rows behind its back.

Two prerequisites: the worker must be running, and the API needs an embedding
provider that can embed text it has never seen — Ollama by default, or any
`openai-compatible` service. `fixture` mode replays recorded vectors only, so it
can serve a seeded corpus but cannot ingest one.

Re-running is safe: existing documents, tickets, logs and investigations are
skipped and action-item statuses are repaired. `--force` re-ingests tickets and
logs. The script ends with a verification summary — row counts, the operations
overview and a search that should return hits — and exits non-zero when one of
those checks fails, so it can gate CI as well as fill a demo.

## Deploying

[`docs/deployment.md`](docs/deployment.md) covers a **$0** deployment: one
application container (API + worker together, so the upload hand-off stays on one
filesystem), Neon for Postgres with pgvector, Upstash for Redis, and a static
build on a CDN. It lists the free-tier limits, the environment matrix, the
migration runbook, a verification checklist and a troubleshooting table.

```bash
# single-container topology, the shape a free host gives you
JWT_SECRET=$(openssl rand -hex 32) APP_PORT=3100 WEB_PORT=4273 \
  EMBEDDING_PROVIDER=fixture \
  docker compose -f docker-compose.single.yml up --build
```

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

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:
the API typecheck and unit tests, the integration suite against pgvector, the
retrieval evaluation, the web typecheck and build, a build of both Docker images,
a dependency audit, and an end-to-end check that starts the real compose stack
and ingests a document through the worker. See
[docs/deployment.md](docs/deployment.md#15-what-ci-checks-before-a-change-reaches-a-deployment).

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

### Embedding providers

Retrieval is only as good as the vectors behind it, and those came from one
hard-coded local Ollama server — the single dependency a free host cannot
satisfy. `EMBEDDING_PROVIDER` now selects the backend:

| Value | What it is | Needs |
|---|---|---|
| `ollama` (default) | a local Ollama server with `nomic-embed-text` | a running Ollama |
| `openai-compatible` | anything that speaks `POST {EMBEDDING_BASE_URL}/embeddings` | `EMBEDDING_BASE_URL`, usually `EMBEDDING_API_KEY` |
| `fixture` | replays vectors recorded from a real model | a recorded fixture file |

`/ai/health` reports the active provider, model, width and endpoint, and whether
that provider answers. Ingestion and search do not know which one is in use.

Two limits are worth stating plainly:

- **The stored width is fixed at 768.** `source_chunks.embedding` is
  `VECTOR(768)`; `EMBEDDING_DIMENSIONS` may only differ with a migration that
  changes the column type. A model that cannot produce 768 dimensions is not
  usable here without one.
- **Fixture mode only knows the texts that were recorded.** It exists so a $0
  deployment can demonstrate real retrieval over the seeded demo corpus; a
  vector is never invented. Ingesting new content in that mode fails with an
explicit error telling you to configure a provider instead.

Every chunk records the model and width that produced its vector, and retrieval
filters on them, so changing provider does not silently compare incompatible
vectors — the affected sources are simply not returned until they are re-indexed
(`POST /documents/:id/reprocess`, or re-ingest) under the new configuration.

```bash
# replay recorded vectors, no embedding service needed
EMBEDDING_PROVIDER=fixture npm run dev

# a hosted API that speaks the OpenAI embeddings shape
EMBEDDING_PROVIDER=openai-compatible \
  EMBEDDING_BASE_URL=https://api.example.com/v1 \
  EMBEDDING_API_KEY=... \
  EMBEDDING_MODEL=text-embedding-3-small \
  EMBEDDING_SEND_DIMENSIONS=true \
  npm run dev
```

## Investigations, action items and operations

An investigation records one operational problem: a problem statement, optional
service and time window, the sources collected as evidence, the analyses that
interpreted them, hypotheses a person verifies or rejects, notes, comments and
follow-up questions. Its lifecycle is `open -> investigating -> resolved ->
closed`; resolving requires a resolution summary, reopening clears it (the
previous summary stays in the activity log), and a closed investigation rejects
metadata edits until it is reopened.

Ownership is optional and never inferred from the creator: a member of the same
organization can be assigned through a composite foreign key, and removing that
membership leaves the investigation unassigned instead of deleting it.

Action items are human-written work attached to one investigation. They start
`open` and move through `in_progress`, `blocked` (with a required reason) and
`completed`, and a completed item can be reopened. New items are refused on a
closed investigation, while existing items remain editable and completable. An
item accepted from an analysis records its source once and snapshots the label:
deleting the analysis clears the link but keeps both the item and its provenance.
Every change is written to `action_item_events` in the same transaction, and
that table is append-only.

```bash
# deterministic evidence-quality gate (no language model is called)
cd apps/api && npm run eval:investigations
```

The evaluation seeds a labelled corpus through the production ingestion path and
measures Recall, Precision and relevance-grading accuracy for evidence
collection, including a case where nothing should match. CI replaces Ollama with
a recorded-vector stub so the numbers are reproducible; see
[`docs/phase-4-report.md`](docs/phase-4-report.md) for the Phase 4 results.

The operational overview is served by `GET /insights/operations` (counts,
recent work) and `GET /insights/action-items` (filtered, paginated queue). Both
are computed in SQL over one organization, so the dashboard and the Operations
page cannot disagree.

## Testing

```bash
cd apps/api
npm test              # unit tests, no database
npm run typecheck

# integration tests need a disposable Postgres; the suite truncates tables
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/opspilot_test npm run test:integration
```

`test:integration` fails immediately when `TEST_DATABASE_URL` is missing or
unreachable, never falls back to `DATABASE_URL`, and applies the real migrations
to that database before running. Never point it at development data. CI runs the
same suite against a `pgvector/pgvector:pg16` service.

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
  src/modules  auth, documents, logs, tickets, ai, admin, insights, investigations, actionItems, organization
  src/middleware auth, org, upload, error
  src/test     integration harness and suites (*.itest.ts)
  src/scripts  migrate, baseline, evaluations
apps/web/src
  pages/       Dashboard, Copilot, Logs, Tickets, Investigations, InvestigationDetail, Operations, Documents, Search, Admin, Settings
  components/  Layout, navigation, shared UI, investigations/ workspace panels
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
