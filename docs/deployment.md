# Deploying OpsPilot AI

This document covers putting OpsPilot on the internet for **$0 of recurring cost**,
using the architecture that already exists: React, Express, PostgreSQL with
pgvector, Redis with BullMQ, and Docker. Nothing here requires a microservice, a
managed orchestration layer, or a paid API.

It states limits and costs explicitly, because a deployment you cannot reason
about is not production-ready, it is just running.

Free-tier figures were checked against each provider's own pricing and docs on
**2026-11-23**. They change; re-check before you rely on them.

---

## 1. The three things that block a free deployment

Everything else is configuration. These three are structural:

1. **Embeddings needed a local Ollama server.** Ollama runs a model on the host
   CPU and cannot be installed on a free container platform. Solved by
   `EMBEDDING_PROVIDER` (`ollama` | `openai-compatible` | `fixture`) — see §5.
2. **The API and the worker shared a filesystem.** The API writes the uploaded
   file; the worker parses it. Split across two platform services, the worker
   gets a path that does not exist. Solved by running both processes in **one**
   container (`apps/api/run-all.mjs`).
3. **Migrations have no pre-deploy hook.** Compose runs them as a gated one-shot
   job; a PaaS gives you a start command. Solved by running `db:migrate`
   explicitly (§7).

---

## 2. Recommended topology

```
                 ┌──────────────────────────────┐
  browser ──────► │ static web (CDN, free)       │  Cloudflare Pages / Netlify
                 │  dist/ from apps/web         │
                 └──────────┬───────────────────┘
                            │ HTTPS + CORS (API origin)
                 ┌──────────▼───────────────────┐
                 │ one application container     │  Render free / Fly free
                 │  ├─ node src/index.ts  :3000  │
                 │  └─ node src/workers/…        │
                 └───────┬──────────────┬────────┘
                         │              │
              ┌──────────▼───┐   ┌──────▼────────┐
              │ Postgres      │   │ Redis         │
              │ + pgvector    │   │ (BullMQ)      │
              │ Neon free     │   │ Upstash free  │
              └───────────────┘   └───────────────┘
                         │
              ┌──────────▼───────────────┐
              │ embeddings (see §5)       │
              │ fixture | hosted API      │
              └──────────────────────────┘
```

Two alternatives, each with a real trade-off:

- **One machine you already own** (home server, NAS) with free Cloudflare Tunnel:
  the full stack including Ollama, no cold starts, no quotas. Costs nothing but
  your hardware being up. Use `docker-compose.yml` unchanged.
- **A split API + worker** on a platform with real shared storage. Correct, but
  it needs a paid disk or object storage; that is out of scope for $0.

---

## 3. Free tiers, as they actually are

| Need | Service | Free allowance | The catch |
|---|---|---|---|
| Postgres + pgvector | **Neon** | 1 GB storage/project, 100 CU-hours/project/month, autoscale to ~2 CU (≈8 GB RAM), ~112 connections on the smallest compute, 6-hour restore window | Compute sleeps after 5 minutes idle and wakes on the next query (fast); 100 CU-hours is roughly **less than 24/7** at the minimum compute unit, so an always-busy instance will suspend for the rest of the month |
| Postgres + pgvector | Supabase | 500 MB/project, 2 projects | Pauses after ~a week idle and needs a manual restore; no backups on free |
| Postgres | Render | 1 GB | The free instance is **deleted after ~30 days**. Do not use it. |
| Redis | **Upstash** | 250 MB, 10 GB bandwidth/month, 10k commands/s | Plenty for a BullMQ queue; it is a network hop, so ingestion is slightly slower than local Redis |
| Container host | **Render (free web service)** | 512 MB RAM, 0.1 CPU | Spins down after 15 minutes with no inbound traffic; ~1 minute cold start; **ephemeral filesystem** |
| Container host | Fly.io "Free" | $5 of usage/month, up to 3 Machines, card required | A credit, not a tier. Cheapest always-on 256 MB machine is ≈ $2.19 per 30 days, so the credit covers roughly two |
| Static web | Cloudflare Pages / Netlify | Generous free static hosting | None worth mentioning here |
| Container host | Railway | $1 of usage/month or a one-time trial grant | Not a usable free tier |

**512 MB is the real constraint** for the application container: `tsx`, Node, the
pg pool and `pdf-parse` all live there. It is enough for a demo, not for
sustained ingestion of large PDFs. Lower `MAX_DOCUMENT_BYTES` (currently 10 MB)
if you see OOM restarts.

Before you commit to Neon, read the arithmetic honestly: 100 CU-hours/month over
730 hours is ~0.137 CU average, and the smallest compute unit is 0.25 CU. A
database that is never idle will exhaust the allowance and be suspended until
the next month. Scale-to-zero is what makes the free plan work for a demo.

---

## 4. Environment

`apps/api/.env.example` is the full reference. For a hosted deployment these are
the values that matter:

| Variable | Required | Production value | Why |
|---|---|---|---|
| `DATABASE_URL` | yes | Neon pooled connection string | Must include `?sslmode=require` for a remote host |
| `DATABASE_SSL` | no | leave unset | TLS is inferred: loopback off, remote on |
| `REDIS_URL` | yes | Upstash Redis URL (TLS: `rediss://`) | Ingestion queue; the API degrades without it |
| `JWT_SECRET` | yes | `openssl rand -hex 32` | The compose default is a placeholder |
| `JWT_EXPIRES_IN` | no | `1d` | The token cannot be revoked, so keep it short |
| `CORS_ORIGINS` | yes | the exact web origin, e.g. `https://opspilot.pages.dev` | Empty means **no** cross-origin browser access in production |
| `TRUST_PROXY` | yes (behind a router) | `1` | Without it the rate limiters key every client on the proxy's IP |
| `EMBEDDING_PROVIDER` | yes | `fixture`, `openai-compatible` or `ollama` | See §5 |
| `GEMINI_API_KEY` | for analysis | your own key | `/ai/ask`, investigation analysis and follow-ups |
| `LLM_MODEL` | no | `gemini-3.5-flash-lite` | The measured default (`docs/phase-5.5-decision.md`); `GEMINI_MODEL` is the older alias |
| `ENABLE_DEV_ENDPOINTS` | no | `false` | `/ai/test-*` stay dark |
| `HEALTH_DETAIL` | no | `false` | `true` adds dependency errors to `/ready` |
| `DB_POOL_MAX` | no | `5` on a 512 MB host | Neon caps connections; a smaller pool is safer |
| `INGESTION_CONCURRENCY` | no | `1` on a 512 MB host | Each concurrent job holds a parse + embed in memory |

`PORT` defaults to 3000. The web build needs `VITE_API_URL` **at build time** —
it is inlined by Vite, so changing the API URL means rebuilding the web image.

### 4.1 Data handling — what leaves the deployment

| Path | Leaves the deployment | Terms to accept |
|---|---|---|
| Generation (`/ai/ask`, analysis, follow-ups) | the question and up to 12 evidence excerpts (≤ 1 200 chars each) | **The Gemini free tier is an "Unpaid Service"**: Google may use inputs and outputs to improve its products, and reviewers may read them. The paid tier does not. |
| Embeddings, `fixture` (**public demo default**) | nothing | the vectors are recorded in the repository |
| Embeddings, `ollama` or a self-hosted `openai-compatible` | nothing off the machine | your own |
| Embeddings, hosted `openai-compatible` | every chunk, at ingest and at search | that provider's terms — verify before ingesting anything private |
| Logs and metrics | no prompt or response text | `aiMetrics` records counts, lengths, model and timing |

Publish one sentence wherever the demo is announced: *"This demo sends questions and evidence excerpts to Google's
Gemini API on the free tier, which may use them to improve its products — do not paste real credentials or
customer data."*

The $0 demo therefore runs `EMBEDDING_PROVIDER=fixture`: the seeded corpus is searchable and an upload is never
embedded by anyone. Ingesting a new document needs `ollama` or a hosted embedder. Leaving `GEMINI_API_KEY` unset
keeps search working and makes generation fail with a provider error instead of inventing an answer.

---

## 5. Embeddings on a free host

`EMBEDDING_PROVIDER` selects the backend. Ingestion and search do not know which
one is running.

| Mode | What it needs | Use it when |
|---|---|---|
| `fixture` | the recorded vectors in `apps/api/src/evaluation/embeddingFixtures.json` | **A $0 demo of the seeded corpus.** Vectors a real model produced, no service called — but only text in the fixture can be embedded (see below) |
| `openai-compatible` | `EMBEDDING_BASE_URL`, usually `EMBEDDING_API_KEY`, a 768-dimension model | You want real ingestion of arbitrary documents and can accept a third-party free tier |
| `ollama` | a reachable Ollama with `nomic-embed-text` | Local development, or a machine you control |

Two rules that are not negotiable:

- **The width is 768.** `source_chunks.embedding` is `VECTOR(768)`. A model that
  cannot produce 768 dimensions needs a migration first.
- **Fixture mode only knows recorded text.** It never invents a vector, so it
  fails with an explicit error for anything unrecorded. That applies to **free-text
  search queries too**: the fixture holds the seeded demo chunks, six recorded demo
  questions and the investigation-evaluation texts CI replays, so a demo visitor
  who types their own query gets a 503 explaining the limit. That is the honest
  version of a $0 demo — the seeded corpus and its recorded questions work with
  real vectors, nothing else does. The six questions are:

  ```
  How do we recover from PostgreSQL connection pool exhaustion?
  Why are large uploads failing with 413?
  What is the rollback procedure for a failed deployment?
  Why did checkout start failing after release 1.42.0?
  How do I restore the production database from a backup?
  What causes Redis key evictions?
  ```
- If a demo must accept arbitrary documents *and* arbitrary questions, it needs a
  real embedding API (`openai-compatible`) or a machine that runs Ollama. There is
  no third option that stays free and correct.

### Demo deployment (recommended for a portfolio link)

```bash
EMBEDDING_PROVIDER=fixture
```

`GET /ai/health` reports `{provider: "fixture", model, dimensions: 768, message:
"N recorded vectors…"}`, so a visitor can see what is and is not real.

What such a deployment can demonstrate: the seeded corpus, its citations, and
the recorded demo questions. What it cannot: a question a visitor types himself.
Price that in before promising a live demo — §8 has the seeding steps.

---

## 6. Building and running

### Single container, one machine (test this locally first)

```bash
JWT_SECRET=$(openssl rand -hex 32) \
APP_PORT=3100 WEB_PORT=4273 \
EMBEDDING_PROVIDER=fixture \
docker compose -f docker-compose.single.yml up --build
```

- web: http://localhost:4273
- API: http://localhost:3100, readiness at `/ready`

The `app` service runs `node run-all.mjs`: two processes, one container, one
filesystem. Each process drains on SIGTERM; the supervisor forwards the signal to
both and exits non-zero if either dies unexpectedly, so the platform restarts a
half-dead container instead of serving API traffic with a dead worker.

### A platform that expects one container

Build the API image and run it with the platform's environment:

```bash
docker build -t opspilot-api apps/api
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DATABASE_URL='postgres://…:5432/opspilot?sslmode=require' \
  -e REDIS_URL='rediss://…' \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e CORS_ORIGINS='https://your-web-origin' \
  -e TRUST_PROXY=1 \
  -e EMBEDDING_PROVIDER=fixture \
  -e DB_POOL_MAX=5 \
  -e INGESTION_CONCURRENCY=1 \
  opspilot-api node run-all.mjs
```

On Render, use that as the start command and `/ready` as the health check path.
On Fly, `fly launch` with the same image, `[http_service] internal_port = 3000`,
and the health check on `/ready`.

### The web build

`apps/web` builds to static files. Either:

- **CDN (recommended):** build with `VITE_API_URL=https://your-api`, publish
  `apps/web/dist`. `apps/web/public/_redirects` provides the SPA fallback so a
  hard refresh on `/investigations/:id` returns `index.html`. Cloudflare Pages:
  build command `npm ci && npm run build`, output `dist`, project root `apps/web`.
- **Container:** `apps/web/Dockerfile` serves `dist` with `server.mjs` — a small
  Node static server with immutable caching for `/assets/*`, `no-cache` for
  `index.html`, gzip for text, and the same SPA fallback. No `node_modules` in
  that image.

---

## 7. Migrations

`apps/api/migrations/*.sql` is the schema source of truth. Applied files are
recorded in `schema_migrations` with a sha256 checksum; editing an applied
migration is refused, so schema changes always arrive as a new file. A Postgres
advisory lock serialises concurrent runs, so two deploys racing here is safe.

```bash
# against the deployment database
DATABASE_URL='postgres://…' npm run db:migrate
```

Where to run it:

- **Compose:** automatic (`migrate` service; `app` waits for it to exit 0).
- **Fly:** `release_command = "node --import tsx src/scripts/migrate.ts"` in
  `fly.toml`, or `fly ssh console -C "npm run db:migrate"`.
- **Render/managed hosts:** their shell (`npm run db:migrate`) before or right
  after the first deploy. Nothing else will do it for you.

A fresh database needs nothing else: `0001` creates the extensions
(`uuid-ossp`, `vector`). On a managed Postgres, the `vector` extension must be
available — Neon and Supabase both provide it.

---

## 8. Seed data for a demo

A fresh deployment is empty, and an empty product demonstrates nothing. Register
once — that creates the user, the organization and an owner membership — then
ingest. Two details cost an hour if you do not know them: the register response
is only `{ token }`, and every tenant-scoped route needs the organization id in
an `x-organization-id` header (the middleware does not fall back to the token).

The repository ships `scripts/seed-demo.mjs`, which does the whole job against a
running deployment — account, six runbooks, tickets, logs and three
investigations — and finishes with a verification summary. It exits non-zero when
a check in that summary fails, so CI treats an empty demo as a failure:

```bash
API_URL=https://your-api node scripts/seed-demo.mjs
```

It needs the worker running and an embedding provider that can embed new text
(`ollama` or `openai-compatible`); `fixture` replays recorded vectors only. The
curl steps below are the same sequence by hand, kept because they show exactly
where those two mistakes bite, and because a deploy box may not have the repo.

```bash
API=https://your-api

# node, not jq: a deploy box has node (the app runs on it) and may not have jq.
TOKEN=$(curl -s "$API/auth/register" -H 'content-type: application/json' \
  -d '{"email":"demo@example.com","password":"a-long-password","organizationName":"Demo"}' \
  | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')

# The organization id is a claim in the token (second segment, base64url).
ORG=$(node -e 'console.log(JSON.parse(Buffer.from(process.argv[1].split(".")[1],"base64url")).organizationId)' "$TOKEN")

# A document. The multipart field name is `file`. Note: the files in
# apps/api/data/ are 0-byte placeholders in this repo, so write your own.
printf '# Checkout runbook\n\nGateway timeouts start with the connection pool.\n' > /tmp/runbook.md
curl -s "$API/documents/upload" \
  -H "authorization: Bearer $TOKEN" -H "x-organization-id: $ORG" \
  -F "file=@/tmp/runbook.md"

# Logs: a JSON array, or {"logs": [...]}. The files in `apps/api/data/` are
# 0-byte placeholders, so send entries inline rather than uploading them.
curl -s "$API/logs/ingest" \
  -H "authorization: Bearer $TOKEN" -H "x-organization-id: $ORG" \
  -H 'content-type: application/json' \
  -d '[{"level":"error","message":"Payment gateway timeout","timestamp":"2026-11-20T09:12:00Z"}]'
```

Under `fixture` mode both are refused, but not at the same point. A search fails
inline with a 503 that says the text was not recorded. An upload is accepted
(202) and only fails once the worker picks up the job — check
`GET /documents`, where the document shows `processingStatus: failed` and the
reason. Until the last retry, the uploaded original is kept so a retry can
re-read it; it is deleted when parsing succeeds or the attempts run out, so a
document that failed for good must be uploaded again, not reprocessed.

Seed in one of the two ways that work:

1. **Seed locally, then move the database.** Run the stack on a machine with
   Ollama, ingest the corpus you want, then `pg_dump` into Neon and switch the
deployment to `fixture`. The stored vectors are already real, so the corpus is
   searchable and citable with no embedding service in production.
2. **Seed against a real provider.** Set `openai-compatible` (or point
   `EMBEDDING_BASE_URL` at a self-hosted server), ingest, and leave it configured.

Neither fixes free-text questions from visitors — a query is embedded at search
time, and fixture mode can only replay recorded ones. If the demo must answer a
visitor's own question, the deployment needs a live provider.

---

## 9. Verification checklist

Run these against the deployment, in order. Each one catches a different class of
failure. They assume `jq` is installed.

```bash
# 1. Process is alive (no I/O)
curl -fsS https://your-api/health

# 2. Database reachable, Redis status visible
curl -fsS https://your-api/ready | jq

# 3. Embeddings configured for this environment
curl -fsS https://your-api/ai/health | jq '{healthy, provider, model, dimensions}'

# 4. CORS actually allows the web origin (a preflight, not a direct GET)
curl -s -o /dev/null -D - -X OPTIONS https://your-api/auth/login \
  -H 'Origin: https://your-web' \
  -H 'Access-Control-Request-Method: POST' | grep -i access-control-allow-origin

# 5. The web build is serving the app shell with a revalidating cache header
curl -sI https://your-web/ | grep -i 'cache-control'

# 6. Deep links work (SPA fallback, not a host 404)
curl -s -o /dev/null -w '%{http_code}\n' https://your-web/investigations/anything

# 7. Sign in, then a tenant-scoped read
curl -s https://your-api/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@example.com","password":"…"}'

# 8. Ingestion is actually being worked on (worker alive, nothing stuck)
curl -fsS https://your-api/ingestion/health \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-organization-id: $ORG" | jq '{jobs, queue, worker}'
```

`worker.status` must be `up` and `jobs.stuckRunning` must be 0 on a healthy
deployment. See §14 for what those numbers mean.

Then in a browser: sign in, check the embeddings badge in the top bar, open
Operations, and run one search. A 200 from `/ready` proves the process and the
database; it does not prove retrieval.

---

## 10. What $0 does not buy

State these on the product itself rather than discovering them in a demo:

- **Cold starts.** After 15 minutes idle the first request takes ~1 minute. The
  UI shows a spinner; there is no way around it on a free web service.
- **Ephemeral storage.** An upload that arrives just as the container sleeps can
  lose its scratch file. The job is marked failed with a reason and can be
  reprocessed (`POST /documents/:id/reprocess`).
- **One instance.** No zero-downtime deploys, no horizontal scaling. A restart is
  a short outage.
- **Database ceilings.** 100 CU-hours/month and 1 GB on Neon; compute scales to
  zero between requests and takes a moment to wake.
- **No point-in-time recovery** beyond Neon's 6-hour window, and **no backups you
  control**. Export what matters if the data matters.
- **No log search.** One log stream, JSON lines, and `x-request-id` to correlate a
  user-reported error with the line that caused it.
- **Fixture embeddings are not a model.** A $0 deployment replays recorded
  vectors: seeded content is genuinely searchable, arbitrary content and
  free-text questions are refused with an explanation. Calling that a working
  RAG demo in front of a user is a claim it cannot carry.
- **Shared CPU.** Analysis and ingestion are slow; `INGESTION_CONCURRENCY=1` is
  the honest setting.

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/ready` 503 | Database unreachable, wrong TLS mode, or pool exhausted | Set `DATABASE_SSL` / `?sslmode=require`; lower `DB_POOL_MAX`; check Neon is not suspended |
| `/ready` 200 but `checks.redis.down` | Redis unreachable | Ingestion stops, the rest works. Check the Upstash URL is `rediss://` |
| `/ai/health` 503, "EMBEDDING_BASE_URL is required" | `EMBEDDING_PROVIDER=openai-compatible` without a URL | Set `EMBEDDING_BASE_URL`, or switch to `fixture` |
| "has not been recorded" on upload or search | Fixture mode, and the text was never recorded | Expected. Use a real provider to accept new documents or a visitor's own question; see §5 and §8 |
| Browser blocks every request (CORS) | `CORS_ORIGINS` does not contain the exact origin | Set it to the scheme+host with no trailing slash, then redeploy |
| Everyone gets 429 at once | `TRUST_PROXY` unset behind a platform router | Set `TRUST_PROXY=1` |
| Uploads fail right after a quiet period | Container was asleep and the scratch file was lost | Retry the upload; see §10 |
| `Migration … changed after it was applied` | An applied migration file was edited | Revert the edit and add a new migration |
| Jobs sit on `running` after a restart | The worker was killed mid-job; the ledger row outlives it | Wait for one sweep (`INGESTION_STALE_JOB_MS`, 10 min by default) or restart the container; check `jobs.stuckRunning` in `/ingestion/health` |
| `/ingestion/health` reports `worker.status: missing` | No worker has beaten for 45 s: the worker process died, or only the API is running | Check the container log for `worker.started`; both processes run in one container (§3) |
| `/ingestion/health` reports `queue.available: false` | Redis unreachable, so ingestion is stopped while the rest of the API works | Check `REDIS_URL`; recovered jobs stay queued until Redis returns |
| Reprocess answers 409 `source_file_unavailable` | The upload was deleted before any text was extracted; there is nothing to re-index | Upload the file again. See §14 |
| Upload accepted but the document never leaves `pending` | No worker: nothing consumes the queue | `/ingestion/health` shows `worker.status: missing`; restart the container |
| 502 from the platform, `/health` fine | Health check path still `/health` while dependencies are down | Point the platform's check at `/ready` |
| Analysis fails with a provider error | `GEMINI_API_KEY` missing or out of quota | Set the key; a free-tier quota resets daily |

---

## 12. Security settings that are not optional in production

- `JWT_SECRET` must be at least 32 characters and not a placeholder. The API now
  **refuses to start** in production otherwise, because a known signing key lets
  anyone mint a token for any user. Generate one with `openssl rand -hex 32`.
- `JWT_EXPIRES_IN` defaults to `1d`. A token cannot be revoked before it expires,
  so a long lifetime is a long window for a stolen one.
- `CORS_ORIGINS` is an explicit list. There is no wildcard support, and an empty
  value blocks all cross-origin browser access.
- `TRUST_PROXY` takes a **hop count** (`1` for one platform router) or an address
  list. Without it every client shares the proxy's IP, so one rate-limit bucket
  covers everyone. `TRUST_PROXY=true` is refused on purpose: it would trust a
  client-supplied `X-Forwarded-For` and let anyone skip the limiter.
- `ENABLE_DEV_ENDPOINTS=false`. The `/ai/test-*` routes stay dark.
- `HEALTH_DETAIL=false` unless you are debugging: the detail can name internal
  hosts and ports.
- Keep `DB_POOL_MAX` below the provider's connection cap.
- Rotate `JWT_SECRET` by redeploying: every existing session is invalidated, which
  is the intended effect and the only revocation mechanism today.

---

## 13. Known security limitations

Stated plainly so nobody assumes a guarantee this system does not make:

- **The browser keeps the token in `localStorage`.** Any script that runs on the
  page can read it. Helmet and a static bundle with no third-party scripts reduce
  the exposure; moving the token to an `HttpOnly` cookie is the real fix and it
  changes the CSRF story, so it is a decided trade-off, not an oversight.
- **No revocation, no refresh tokens.** A token is valid until it expires (one day
  by default). Disabling an account does not invalidate the tokens already issued
  to it; rotating `JWT_SECRET` invalidates all of them.
- **No MFA, no password reset, no email verification.** Registration is open to
  anyone who can reach the API. That is deliberate for a demo deployment; a real
  one needs an invitation or a verified domain in front of it.
- **Rate limits are per process.** One instance means one bucket; two instances
  behind a balancer would each allow the full budget. A shared store (Redis) is
  the fix when that matters.
- **No WAF, no IP reputation, no request signing.** The API trusts the transport
  and the platform's TLS. Upload size, JSON body size and query length are
  bounded, which is the part that protects memory, not availability.
- **Uploads are validated by extension, not content.** A `.pdf` that is not a PDF
  fails in the parser with a recorded reason; it is not executed or served back.

---

## 14. When an ingestion job dies with the process

A free host restarts on its own schedule: a deploy, an idle spin-down, an OOM
kill. The worker can be killed between "this job started" and "this job
finished", which leaves a row in `ingestion_jobs` marked `running` with nothing
alive that could move it. The UI showed "processing" indefinitely.

The worker sweeps for that state. At start, and every
`INGESTION_RECOVERY_INTERVAL_MS` (60 s), it looks for rows left in `queued` or
`running` that have not changed for `INGESTION_STALE_JOB_MS` (10 min) and:

- **attempts remain** — the job goes back to the queue under the **same** job id,
  so BullMQ cannot run the same source twice at once. The document is parsed
  from the original upload when that file is still on disk; the ledger stores the
  path for exactly this case.
- **attempts are used up** — the job becomes `failed` with the reason, and a
  document source stops showing `processing` and records the same reason.

Nothing is requeued while BullMQ still owns the job (waiting, delayed or
active), so a slow-but-alive run is never duplicated. A Redis outage leaves the
row untouched and retries on the next sweep rather than declaring work failed.

### The uploaded original is not kept

The file is deleted once its text is extracted, or when the last attempt fails.
Reprocessing therefore re-reads the extracted text, not the upload:

- **stored text exists** — `POST /documents/:id/reprocess` re-chunks and
  re-embeds it. This is how a document is re-indexed after a provider change.
- **no stored text, nothing running** — the request answers **409**
  (`code: source_file_unavailable`). The file was deleted before anything was
  extracted, so there is nothing to index: upload it again. It used to answer
  202 and then fail with "Document has no extracted text", which made an
  impossible request look accepted.
- **a job is still queued or running** — the request is accepted and returns that
  job (deduplicated), because the file may still be on disk and about to be
  parsed.

### One read for "is ingestion working?"

`GET /ingestion/health` (auth + `x-organization-id`) answers what used to need
three places:

```json
{
  "generatedAt": "2026-11-23T12:00:00.000Z",
  "staleAfterSeconds": 600,
  "jobs": {
    "counts": { "queued": 0, "running": 1, "succeeded": 12, "failed": 1, "skipped": 0 },
    "total": 14,
    "stuckRunning": 0,
    "oldestQueuedSeconds": null
  },
  "queue": {
    "available": true,
    "counts": { "waiting": 0, "active": 1, "delayed": 0, "failed": 0, "completed": 40 }
  },
  "worker": { "status": "up", "lastHeartbeatSecondsAgo": 3 }
}
```

- `jobs` is this tenant's ledger. `stuckRunning` uses the sweep's threshold, so a
  non-zero value counts jobs the sweeper is about to handle.
- `queue` is the transport. `available: false` means Redis is unreachable; the
  endpoint still answers, because that is exactly when you need it.
- `worker` comes from a heartbeat key with a 45 s TTL: `up`, `stale`, `missing`
  (no worker has reported) or `unknown` (Redis unreachable). A queue with
  waiting jobs proves nothing about whether anyone is consuming it; this is what
  makes a dead worker visible.

The worker logs `worker.drained` with the remaining queue counts on shutdown, so
"the queue was empty when this stopped" is a recorded fact rather than an
assumption.

## 15. What CI checks before a change reaches a deployment

`.github/workflows/ci.yml` runs six jobs on every pull request and every push to
`main`. Each one exists because a failure it catches is invisible to the others.

| Job | Catches |
| --- | --- |
| API typecheck and unit tests | Logic regressions, without needing a database |
| API integration tests | SQL, migrations and tenant scoping against real pgvector |
| Investigation evaluation | Retrieval quality regressions (recorded vectors, so no model and no key) |
| Web typecheck and build | Front-end type errors and a build that no longer produces `dist` |
| Docker images | A Dockerfile whose `COPY`, lockfile or native dependency no longer resolves |
| End-to-end | The deployed topology: two processes in one container, queue, worker, static web build |

### The dependency audit gate

`audit` fails on moderate or worse, with a different scope per app:

- **API** -- the whole tree. The image installs dev dependencies because `tsx` is
  what runs the service, so "dev" dependencies are installed in production here;
  gating only the production tree would gate the tree that does not ship.
- **Web** -- `--omit=dev`. The runtime image contains the build output and
  `server.mjs`, no `node_modules` at all, so only the build-time tree can ship
  anything.

One advisory is deliberately not gated: Vite 5's development-server path
traversal, which needs a major upgrade to Vite 8. It is a development server that
is never deployed (the image serves `dist` through `server.mjs`), so the upgrade
is a front-end chore rather than a deployment risk. Everything else is clean at
moderate and above; do not lower the threshold to make a run green, and do not
raise it without writing down what is being accepted.

The lockfiles are committed and `npm ci` is used everywhere, so the audit sees
exactly what the images install. `npm audit fix` cleared the direct dependency
advisories (axios, multer, proxy-addr, bullmq) without a breaking change; a future
advisory that needs a major version is a decision, not an automatic bump.

### The end-to-end check

`e2e` starts `docker-compose.single.yml` -- the real deployment topology -- with a
`docker-compose.e2e.yml` overlay that adds a deterministic embedding stub, then
runs `apps/api/e2e/smoke.mjs`. The script signs up, signs in, uploads a document,
waits for the worker to index it, searches for it, and checks that anonymous
requests get 401 and a foreign tenant gets 403. The job then runs
`scripts/seed-demo.mjs` against the same stack, because the demo path — tickets,
logs, investigations and action items — is what a visitor actually sees, and the
seed exits non-zero if its verification summary comes back empty.

The embedding stub returns the same unit vector for every input, so similarity is
always 1.0. That is intentional: the check proves the pipeline (parse, chunk,
embed, store, rank) works, not that embeddings are good -- the evaluation job
measures retrieval quality. It also means the check needs no model download, no
API key and no network beyond the compose project.

To run it locally:

```bash
JWT_SECRET=$(openssl rand -hex 32) \
  docker compose -f docker-compose.single.yml -f docker-compose.e2e.yml up -d --build
node apps/api/e2e/smoke.mjs
docker compose -f docker-compose.single.yml -f docker-compose.e2e.yml down -v
```

`E2E_API_URL` and `E2E_WEB_URL` point the script at another host or port. When it
fails, the CI job prints the last 300 lines from every container before tearing
the stack down.
