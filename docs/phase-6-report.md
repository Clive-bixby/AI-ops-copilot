# Phase 6 report — hardening closeout

Phase 6 followed `docs/phase-6-audit.md`: close the release-blocking findings from
the Phase 5 review without adding product features. This report records what was
changed, what was actually run, what the gates catch, and what is still open.
It covers M1–M7; M8 is this document.

- Repository: `D:\ai-ops-copilot`, branch `main`, local commits only (nothing pushed).
- Last verified: **331/331 unit tests**, **124/124 integration tests** (42 suites,
  216 s), `npm run typecheck` clean, web **17/17 tests**, build 462.69 kB
  (127.71 kB gzip), lint 0 errors / 8 pre-existing `exhaustive-deps` warnings,
  retrieval evaluation passing its new quality floor.

## Milestones

| Milestone | Commit | What it established |
|---|---|---|
| M1 | `635760a` | Deterministic single-organization login; tenant-isolation suites |
| M2 | `2bb11d6`, `3d54826` | AI rate budget, ingest batch caps, bounded pagination, upload content sniffing, logger unification |
| M3 | `d83e139`, `c48b84b` | Untrusted-data framing + shared defanger in all three prompts; mocked-provider failure matrix for `/investigations/:id/analyze` |
| M4 | `f0c54b8` | Non-root image, `DATABASE_SSL_CA`, backup/restore scripts + executed drill, ingestion failure tests |
| M5 | `5d55723` | AI, ingestion, investigation sub-resource and auth-audit HTTP suites; generic registration conflict; auth audit trail with a hashed identity |
| M6 | `f0bdcca`, `b8479e8` | Vitest + Testing Library in `apps/web` (17 tests); strict CSP on `server.mjs`, verified in a browser |
| M7 | `53773e4`, `dbe5d7d`, `520149f` | Web lint/tests gated in CI; retrieval-evaluation job with a measured recall floor; actions pinned to SHAs; dependency review on pull requests |

## Verification actually run

Commands below were executed in this environment; results are the real exit
status and counts.

| Command | Result |
|---|---|
| `cd apps/api && npm run typecheck` | exit 0 |
| `cd apps/api && npm test` | 331 tests, 331 pass, 0 fail |
| `npm run test:integration` against `pgvector/pg16` on 55433 | 124 tests, 124 pass, 0 fail, 216 s |
| `cd apps/web && npm test` | 4 files, 17 tests passed |
| `cd apps/web && npm run build` | exit 0, 79 modules |
| `cd apps/web && npm run lint` | exit 0, 0 errors, 8 warnings |
| `npm run eval:retrieval` (recorded vectors, pgvector) | exit 0 — hybrid recall@10 **0.9907**, MRR 0.9861, nDCG 0.9801 |
| `npm run eval:retrieval -- --queries hard` | exit 0 — hybrid recall@10 **0.9306** (ungated set) |
| CSP served by `server.mjs`, loaded in Chromium | header present; fonts and shell load; hashed inline theme bootstrap runs; injected inline script refused; SPA deep link serves |

## What the gates catch now

Each gate was proven by breaking it and observing the failure, then reverting.

| Gate | Broken on purpose | Observed |
|---|---|---|
| Web lint | `debugger;` in a new file | exit 1, `no-debugger` |
| Web typecheck | `const x: number = "not a number"` | exit 2, `TS2322` |
| Web tests | `expect(1).toBe(2)` | exit 1, `FAIL src/lib/api.test.ts` |
| Retrieval quality | `--floor 0.999` against measured 0.9907 | exit 1, `Quality gate failed: hybrid recall@10 0.9907 is below the 0.9990 floor` |
| Retrieval pipeline | missing fixture vector / SQL or indexing error | exit 1 (hard error, not a silent zero) |

The floor is 0.95 on the standard 36-query set, one full query below the measured
0.9907 (losing every relevant source of one query costs at most 0.028). The
held-out 12-query set sits at 0.9306 by design, so it is ungated unless `--floor`
is passed explicitly.

## Readiness scorecard

| Area | State | Evidence | Remaining gap |
|---|---|---|---|
| Auth and tenancy | Ready | Login matrix, timing-equivalent failures, hashed audit trail, cross-tenant read/write suites | Rate limiting is per process (F9) |
| AI endpoints | Ready with caveats | `/ai/search`, `/ai/ask`, `/ai/health` scoping and failure contract tested with scripted servers | Answer quality is the provider's; prompts are hardened, not injection-proof |
| Ingestion | Ready | Retry, redelivery, malformed PDF, upload retention, batch caps, jobs and reindex tests | Only the Docker image runs the worker; no test of a multi-replica race |
| Investigations | Ready | Timeline, evidence link/unlink, hypothesis verdict, notes, windowed evaluation, action items | — |
| Frontend | Ready with caveats | 17 tests over the API client, session expiry, route guard, 503 cards; strict CSP in-browser | No interaction/form-validation suite yet; no browser E2E in CI |
| CI | Ready | Build, lint, tests, integration, two evaluations, image builds, compose E2E, pinned actions, dependency review | Not exercised on GitHub in this session (no push) |
| Operations | Ready | Non-root image, TLS CA support, backup/restore scripts with a drill, `/ready` gating | Single-machine backup; no off-host copy automation |

## Residual risks (accepted and recorded)

- **F9 — in-memory rate limits**, per process. Behind multiple replicas the
  effective limit multiplies. Documented, not fixed: a shared store is a
  deployment decision.
- **F14 — `/ai/health` is public with detail.** Accepted: it reports model and
  provider state, not secrets or data.
- **F15 — sessions live in `localStorage`, no revocation.** A stolen token is
  valid until expiry. Accepted for a demo-scale product; the alternative is
  server-side sessions and CSRF handling.
- **F20 — no row-level security.** Tenant isolation is enforced in queries and
  proven by tests; a missed `WHERE organization_id` is a code bug, not caught by
  the database.
- **Provider dependency.** Generation and (optionally) embeddings call an external
  API. CI never does; a live run can fail for reasons the code cannot control.
- **Prompt injection is mitigated, not solved.** Evidence is framed and defanged
  so data cannot close its own block; a model can still be persuaded.
- **Retrieval fixture growth.** The recorded-vector fixture is now 2.1 MB and
  covers the standard corpus and queries; `--queries hard` needs a live embedder
  or additional recordings. Any corpus or model change requires re-recording.
- **CSP trade-offs.** `style-src` keeps `'unsafe-inline'` for React style
  attributes, and the Google Fonts hosts are allowlisted.

## Not verified

- CI has not run on GitHub: the retrieval job, the SHA pins and dependency review
  are unverified until a push. Actions were pinned to commit SHAs resolved from
  the GitHub API, and the workflow parses as YAML, but that is not a run.
- The CSP was checked on `127.0.0.1:4180` (a local build), not on the compose
  stack's `:4173`; no authenticated flow was exercised under the policy.
- No browser end-to-end suite exists; the compose E2E job covers HTTP flows only.

## Phase 7 recommendation

1. **Push and watch CI**: the first run after a push is the real proof of the
   M7 jobs, the pins and dependency review.
2. **Make limits and sessions deployable**: shared rate-limit storage and
   server-side session revocation are the two accepted risks that block a
   multi-replica deployment.
3. **Grow the frontend suite** to interactions and form validation, then add a
   browser E2E smoke under the CSP.
4. **Re-record fixtures deliberately** when the corpus or embedding model
   changes, and keep the retrieval floor as the regression tripwire.
5. **Tenant isolation under RLS** only if the product moves to direct database
   access or multi-tenant scale; today the query-level enforcement is tested.

## Open decisions

- Commit `docs/phase-6-audit.md` and `docs/phase-6-handoff.md`, or keep them as
  working documents. Both are still untracked.
- Whether to raise retrieval coverage for the held-out set by recording its
  vectors, and whether to gate strictness (`style-src`) by removing inline styles.
