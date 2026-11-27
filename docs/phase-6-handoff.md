# Phase 6 handoff — state after M4

Read this first. It is written for an agent starting with **no conversation
history**: it records what is done, what is decided, what is verified, and what
remains. The plan it implements is `docs/phase-6-audit.md`.

- Repository: `D:\ai-ops-copilot`, branch `main`, nothing pushed (local commits only).
- Last verified state: **331/331 unit tests**, **100/100 integration tests** (31 suites),
  `npm run typecheck` clean, web build and lint green (0 errors, 8 `exhaustive-deps` warnings).
- Phase 6 covers **M1–M8**. M1, M2, M3, M4 are complete and committed. M5, M6, M7, M8 remain.

## Commits (local, in order)

| Commit | Milestone |
|---|---|
| `635760a` | M1 — deterministic single-organization login, tenant-isolation suites |
| `2bb11d6` | M2 — AI rate budget, ingest batch caps, bounded pagination, upload content sniffing, logger unification |
| `3d54826` | M2 follow-up — removed upload cleanup multer already performs |
| `d83e139` | M3 — untrusted-data framing + shared defanger in all three prompts |
| `c48b84b` | M3 — mocked-provider failure matrix for `/investigations/:id/analyze` |
| `f0c54b8` | M4 — non-root image, `DATABASE_SSL_CA`, backup/restore scripts + drill, ingestion failure tests |

## Standing rules (do not break these)

1. **Never push.** Commit only when the user asks. Each milestone ends with a
   report of changed files, commands actually run, real output, remaining risks,
   and a commit recommendation.
2. **Never stage, modify or delete** the untracked `.kilo/` and
   `stitch_opspilot_ai_product_redesign/` directories. `docs/phase-6-audit.md` is
   also still untracked (an M0 deliverable the user has not asked to commit).
3. No new product features, no new paid services, no live external API calls in
   tests, no secrets in logs or reports.
4. Do not weaken or delete existing tests to make a suite green. Assert
   behaviour (rows, state, isolation), not bare status codes.
5. Never claim security or production readiness from static reading or a green
   suite. Distinguish "unit-tested", "verified in a running stack", and "not
   verified".
6. Commit footer: `🤖 Generated with Codebuff` + `Co-Authored-By: Codebuff <noreply@codebuff.com>`.

## Decisions already made (do not reopen without the user)

- **Single organization per user.** Login picks the oldest membership
  (`ORDER BY created_at ASC, id ASC LIMIT 1`); no membership → 409 with a fixed
  message. Not a multi-org switcher.
- **`/ai/health` stays public with full detail** (F14 accepted, documented).
- **Pagination**: `limit` default 200, max 500; `offset` default 0, max 100 000;
  responses stay bare arrays so the SPA is unchanged; `id DESC` tie-break added.
- **AI budget**: `AI_RATE_LIMIT_MAX` default 20/min, provider-calling routes only.
- **Ingest cap**: `MAX_INGEST_BATCH_ENTRIES = 500`.
- **CSP on `apps/web/server.mjs` is deferred to M6**, where a browser can verify
  it; `connect-src` must name a build-time origin.
- **Prompt hardening**: evidence quoted in `<untrusted_*>` / `<context>` blocks,
  all quoted text through one defanger (`apps/api/src/modules/ai/promptSafety.ts`)
  so data cannot close its own block. Defence in depth, **not** injection-proof.
- **Failure contract**: provider timeout → 504, everything else (429 exhausted,
  5xx, malformed, oversized output) → 502, with a typed failure row stored.
- **M4 defaults**: reuse the base image's `node` user; `DATABASE_SSL_CA` is a PEM
  **file path**; backup scripts shell out to `pg_dump`/`pg_restore` with a Docker
  fallback; Redis binds `127.0.0.1` in `docker-compose.yml`.

## Environment facts

- Docker Desktop is running (server 29.2). The host has **no** `pg_dump`,
  `pg_restore` or `psql`; the backup scripts fall back to
  `pgvector/pgvector:pg16` through Docker, which works and was exercised.
- Integration tests need a disposable database. Standard command:
  ```bash
  docker run -d --name opspilot-test-db -e POSTGRES_USER=ops -e POSTGRES_PASSWORD=ops \
    -e POSTGRES_DB=opspilot_test -p 55433:5432 pgvector/pgvector:pg16
  cd apps/api && TEST_DATABASE_URL="postgres://ops:ops@127.0.0.1:55433/opspilot_test" \
    JWT_SECRET="integration-test-secret-0123456789abcdef" NODE_ENV=test npm run test:integration
  docker rm -f opspilot-test-db
  ```
  Remove the container afterwards; do not leave it on 55433.
- **A live AI provider is reachable from this machine.** Tests must not assume
  provider absence; that is why the rate-limit test posts an empty query (400
  after the limiter counts it) and why failure tests use scripted local servers.
- `npm test` globs `src/**/*.test.ts`; `npm run test:integration` globs
  `src/**/*.itest.ts` with `--test-concurrency=1`. A new suite must match those
  names or it silently never runs.
- Web app: `npm run build` and `npm run lint` in `apps/web`; there is still **no
  test runner** there (that is M6).

## What M1–M4 established (where the code lives)

- `apps/api/src/modules/auth/auth.service.ts` — one bcrypt compare on both login
  branches (dummy hash for unknown email), oldest-membership selection, 409.
- `apps/api/src/test/integration/auth.itest.ts`, `tenancy.itest.ts` — auth matrix
  and cross-tenant read/write tests.
- `apps/api/src/middleware/rateLimit.middleware.ts` (`aiRateLimiter`),
  `src/config/limits.ts`, `src/utils/pagination.ts`, `documents.routes.ts` content
  sniffing.
- `apps/api/src/modules/ai/promptSafety.ts` — `defangUntrustedText`; re-exported
  from `investigations/analysisPolicy.ts`.
- `apps/api/src/modules/investigations/analysisPolicy.ts` / `followUpPolicy.ts` —
  prompt assembly; their `*.test.ts` hold the prompt-contract tests.
- `apps/api/src/test/integration/aiFailures.itest.ts` — scripted-provider matrix
  (504/502/502/502/502/502, request counts).
- `apps/api/src/core/databaseSsl.ts` + test, `db.ts` (single `db.tls_without_ca`
  warning); `apps/api/Dockerfile` (`USER node`, chowned `/app/uploads`).
- `scripts/pg-cli.mjs`, `scripts/db-backup.mjs`, `scripts/db-restore-verify.mjs`,
  `docs/backup-restore.md` (procedure + the executed drill output).
- `apps/api/src/test/integration/ingestionFailure.itest.ts` — malformed PDF,
  embedding outage with retry, redelivery no-op, upload retention/deletion.
- `apps/api/src/modules/ai/documentParser.test.ts` — malformed/empty/vanished input.

## Remaining milestones

### M5 — Backend regression testing (findings F1 residual, T8)

Fill the gaps the coverage matrix in the audit still lists, **without** repeating
what M1/M3/M4 already cover:

- **AI domain over HTTP**: `/ai/search`, `/ai/ask`, `/ai/health` — tenant scoping
  and the "no context" answer, using the existing scripted-server technique so no
  live call happens. The audit lists F1 for AI as untested.
- **Ingestion endpoints**: `/ingestion/health`, jobs list/get, reindex cap —
  cross-tenant reads are untested (only recovery policy is).
- **Investigations**: timeline, evidence link/unlink, hypothesis verdict,
  notes/comments — partially covered end to end only.
- **Auth audit trail (F18)**: login success/failure logged with a hashed email or
  user id only, never the password or token; assert via the logger output.
- **F11 residual**: confirm register answers a generic conflict message (not
  "Email already exists") and both login failure modes are timing-equivalent;
  if the generic message is still missing, that is a product decision first.
- **F16 residual**: `console.warn` remains at module scope in
  `ai/llm/index.ts`, `ai/rag.service.ts`, `ai/retrieval.service.ts` and
  `aiMetrics.util.ts` (the last is the metrics stream on purpose). Decide per
  call site; do not claim a clean `console.*` grep until then.

### M6 — Frontend reliability (F2, F15 residual)

- Add Vitest + Testing Library to `apps/web` (this is the first new dev
  dependency in Phase 6; it is explicitly in the audit scope).
- Cover: `request()` status semantics (only explicitly accepted statuses do not
  throw), session expiry, protected routes, the AI-health cards rendering partial
  data on **503** (the regression the audit says is needed), form validation,
  error/empty states.
- Add the strict CSP to `apps/web/server.mjs` (`connect-src` must include the
  build-time API origin) and verify it in a browser.
- Default and max values for any new UI behaviour must be stated **before**
  touching the frontend.

### M7 — CI and quality gates (F13)

- Add `npm run lint` to the web job, a retrieval-evaluation job
  (`npm run eval:retrieval`, mirroring the investigation-eval fixture stub), and
  the frontend test job from M6.
- Pin GitHub Actions to commit SHAs; add `dependency-review-action` on pull
  requests; keep the existing `npm audit` thresholds (do not raise them).
- Prove the gates fail when they should (deliberately broken typecheck, lint,
  test).

### M8 — Closeout

- `docs/phase-6-report.md`: commands run, real results, readiness scorecard,
  Phase 7 recommendation. Record residual risks: **F9** (in-memory rate limits,
  per process), **F14** (public health detail), **F15** (token in localStorage,
  no revocation), **F20** (no RLS), **provider dependency** and **prompt
  injection is mitigated, not solved**.
- Decide whether to commit `docs/phase-6-audit.md` and this handoff.

## Verification commands (run these before reporting any milestone)

```bash
# API
cd apps/api && npm run typecheck && npm test
# Integration (needs the container above)
npm run test:integration
# Web
cd apps/web && npm run build && npm run lint
# Image, when the Dockerfile changes
docker build -t opspilot-api:check ..  # from apps/api: docker build -t opspilot-api:check .
docker run --rm opspilot-api:check id   # must print uid=1000(node)
```

## Known gaps that are documented, not bugs

- `documents_processed_at_check`: a document row with `processing_status =
  'processed'` must also set `processed_at` (cost me a drill run; insert
  accordingly in fixtures).
- Fixture embeddings only replay recorded text; a document outside the fixture
  fails at the worker with an explicit message, by design.
- `/ready` answers 200 only when both Postgres and Redis are up.

## Suggested next step

Start **M5**: read `docs/phase-6-audit.md` §7 (coverage matrix), list which rows
are still bare, and write the missing HTTP-level suites with the scripted-server
pattern. Report the plan before writing code if the user asks for a gate.
