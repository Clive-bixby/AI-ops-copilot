# Phase 4 Report — Investigations, Follow-up Work and Operations

Status: **M1–M4 delivered and verified; M5 closeout complete for the items below.**
Scope: the investigation workflow, action items, discussion, and the operational
overview in `apps/api` and `apps/web`.

This report describes what is actually in the repository and what was actually
run. It also records where the implementation departs from the approved plan, so
the differences are decisions rather than surprises.

---

## 1. Delivered milestones

### M1 — Investigation ownership and the complete investigation workspace

- `0007_investigation_ownership.sql`: nullable `investigations.owner_user_id`
  with a composite foreign key to `memberships(user_id, organization_id)` and
  `ON DELETE SET NULL (owner_user_id)`; two owner indexes; `owner_change` added
  to the activity vocabulary.
- Owner fields in list/detail, optional `ownerUserId` on create (backend default
  `NULL`), assign/unassign on update, membership validation, attributed
  `owner_change` activity, owner filters (`me`, `unassigned`, or a member id).
- `GET /organization/members` for every authenticated member; `/admin/members`
  stays owner/admin-only.
- `withheld` persisted in `evidence_added` metadata so the collection summary
  survives a reload.
- Web: `/investigations` (server-side filters, pagination, create form that
  preselects the signed-in user), `/investigations/:id` (edit with optimistic
  concurrency, lifecycle controls, evidence, analysis, hypotheses, notes,
  follow-ups, timeline, activity).

### M2 — Action items

- `0008_action_items.sql`: `action_items` and append-only `action_item_events`,
  provenance with immutable `source_label`, deletion-safe `ON DELETE SET NULL`
  source links, blocked-reason and priority CHECKs, an insert/update provenance
  trigger, and a `BEFORE UPDATE` trigger that refuses event rewrites.
- Policy/service/routes/controller for create, list (status, priority, assignee,
  pagination), detail and update; events written in the same transaction.
- Completed items can be reopened (`completed -> open`, clearing completion
  fields); new items are rejected with `409` on a closed investigation while
  existing items stay editable and completable.
- Web: action-item tab with create, edit, status transitions, assignee and due
  date, blocked-reason prompt, history, and accepted-suggestion labelling.

### M3 — Discussion

- `0009_investigation_discussion.sql`: `comment` joins the activity vocabulary;
  notes and comments share one append-only stream and one non-empty-body CHECK.
- `POST /investigations/:id/comments`; the existing `POST /notes` and the
  activity stream are unchanged. Comments are allowed on closed investigations.
- Web: discussion feed with distinct note/comment labels, author and time, and
  pagination through the existing activity order.

### M4 — Operational overview

- `GET /insights/operations`: investigation counts by status and severity,
  assigned-to-me, unassigned, recently updated, recently resolved; action-item
  summary (open/in progress/blocked/completed, overdue, due soon,
  assigned-to-me, unassigned), by status and by priority, recently completed.
- `GET /insights/action-items`: cross-investigation queue with SQL filters
  (status, priority, assignee, due, investigation) and SQL pagination. The
  summary is organization-wide; `total` reflects the active filters.
- "Due soon" is 48 hours, defined once on the server.
- Web: `/operations` with Overview and Action items tabs, plus a compact
  operational strip on the command center. Every number comes from the API; no
  metric is recomputed from a page of rows.

---

## 2. Product decisions as implemented

| Decision | Implementation |
|---|---|
| Any member can assign investigations and action items | No role check on assignment; membership is validated against the organization |
| Notes and comments share one feed with labels | One `investigation_activity` table, two types, one chronological projection |
| No new action items on closed investigations | Create returns `409`; update does not check investigation status |
| Existing action items remain usable after close | List/detail/update continue to work on a closed investigation |
| Completed items can be reopened | `completed -> open`, clearing `completed_at` and `completed_by` |
| Blocked requires a reason | Enforced by policy and a DB CHECK; leaving `blocked` clears it |
| Priorities are `low/medium/high/critical` | Enum values in policy, DB CHECK, web filters |
| Owner defaults to unassigned on the backend | Column is nullable; only the create form preselects the current user |
| Resolving with open action items is allowed | The backend does not block it and never changes item status |
| Action-item events are not merged into the timeline | `action_item_events` stays a separate history; merge deferred |

---

## 3. Data model notes

- Every child table references its parent through a composite
  `(id, organization_id)` key, so a row from another tenant's investigation is
  impossible at the storage layer, not only in application code.
- Provenance is write-once. `created_from` and `source_label` are immutable; a
  source id may only be cleared by a foreign-key action, never attached or
  repointed. The database trigger is the backstop for the service validation.
- Deleting an analysis (or hypothesis) clears the source id, keeps the label and
  the item, so provenance never breaks a deletion and never silently disappears.
- `action_item_events` has no update or delete route; a trigger rejects in-place
  rewrites while parent cascades still work.
- `ON DELETE SET NULL (column)` requires PostgreSQL 15+. Verified on
  PostgreSQL 16.16.
- Migrations `0005` and `0006` were not modified; Phase 4 arrives entirely as
  `0007`–`0009`.

### Implemented deviations from the approved plan

1. **Provenance vocabulary.** The plan used `manual | hypothesis | evidence`.
   The shipped model is `manual | analysis` with `source_analysis_id` and
   `source_hypothesis_id`. An action item is accepted from an analysis or one of
   its hypotheses — evidence is what the analysis read, not what proposed the
   work — so evidence provenance would have created two ways to say the same
   thing. The immutability, label-snapshot and deletion-safety rules from the
   plan are all preserved.
2. **No `cancelled` status.** The lifecycle is
   `open | in_progress | blocked | completed`, matching the shipped UI and tests.
   Cancelling work is currently expressed by completing it with a description or
   by leaving the investigation closed.
3. **Blocked reason CHECK.** The database requires a non-empty reason whenever
   `status = 'blocked'`; the service clears the reason when leaving `blocked`,
   and the event metadata keeps the previous value. The plan's stricter
   "reason must be null when not blocked" is enforced in the service rather than
   duplicated in a CHECK.
4. **Discussion is not a new table.** Comments live in the activity stream, as
   the plan's projection endpoint assumes; there is no separate comment table.
5. **Operations uses two endpoints.** `GET /insights/operations` serves the
   overview and `GET /insights/action-items` serves the queue, so pagination and
   filters never burden the counts.

---

## 4. API surface added in Phase 4

| Method | Path | Purpose |
|---|---|---|
| GET | `/organization/members` | Member directory for assignment pickers |
| POST | `/investigations` | Create, with optional owner and evidence collection |
| GET | `/investigations` | List with status, severity, service, text and owner filters |
| GET | `/investigations/:id` | Detail with activity and evidence |
| PATCH | `/investigations/:id` | Metadata, owner, lifecycle, `expectedUpdatedAt` |
| POST | `/investigations/:id/evidence/collect` | Run real evidence collection |
| POST | `/investigations/:id/evidence` | Manually link a source |
| DELETE | `/investigations/:id/evidence/:evidenceId` | Unlink evidence |
| POST | `/investigations/:id/analyze` | Synchronous analysis |
| GET | `/investigations/:id/analysis` | Stored analysis and hypotheses |
| PATCH | `/investigations/:id/hypotheses/:hypothesisId` | Human verdict |
| POST/GET | `/investigations/:id/questions` | Follow-up questions with citations |
| POST | `/investigations/:id/notes` | Note |
| POST | `/investigations/:id/comments` | Comment |
| GET | `/investigations/:id/timeline` | Time-ordered projection |
| GET/POST | `/investigations/:id/action-items` | List/create action items |
| GET/PATCH | `/investigations/:id/action-items/:actionItemId` | Detail and update |
| GET | `/insights/operations` | Operational overview counts |
| GET | `/insights/action-items` | Cross-investigation queue |

---

## 5. Verification performed

| Check | Command | Result |
|---|---|---|
| API typecheck | `cd apps/api && npm run typecheck` | pass |
| API unit tests | `cd apps/api && npm test` | **200 pass, 0 fail** |
| API integration tests | `TEST_DATABASE_URL=… npm run test:integration` | **50 pass, 0 fail** |
| Web build | `cd apps/web && npm run build` | pass |
| Fresh migration run | `db:migrate` against an empty database | 9/9 applied |
| Investigation evaluation (real embeddings) | `npm run eval:investigations` with `nomic-embed-text` | thresholds **PASS** |
| Investigation evaluation (CI fixture) | same, against the recorded-vector stub | thresholds **PASS** |

Integration coverage includes owner isolation, the member directory, closed
investigation rules, `409` conflicts, action-item lifecycle and provenance
survival after source deletion, append-only events, discussion ordering and
attribution, and exact operations counts with tenant isolation. The harness
requires `TEST_DATABASE_URL` and never falls back to `DATABASE_URL`.

### Evaluation results

Both runs used the labelled corpus of five cases (four positive, one with no
matching evidence):

| Metric | Real `nomic-embed-text` | CI recorded-vector stub |
|---|---|---|
| Cases | 5 (4 positive) | 5 (4 positive) |
| Recall | 1.00 | 1.00 |
| Precision | 1.00 | 1.00 |
| Grading accuracy | 1.00 | 1.00 |
| Selected sources | 11 | 11 |
| Extra sources | 0 | 0 |
| Forbidden hits | 0 | 0 |
| Duplicate violations | 0 | 0 |
| Empty-case violations | 0 | 0 |
| Window failures | 0 | 0 |
| Mean latency | 181 ms | 43 ms |

Per case: `pool-exhaustion`, `deploy-rollback`, `redis-eviction` and
`windowed-deadline` each found every expected source at the expected relevance
grade; `no-matching-evidence` selected nothing instead of inventing a match. The
windowed case also passed bounds, exclusion, undated-source, manual-link and
timeline-order checks. Weak candidates were withheld and reported as warnings
rather than silently dropped.

The fixture run exists because CI must be deterministic and needs no model
download; it produced the same quality metrics, which is the point of recording
the vectors.

---

## 6. What was not verified

- **No manual UI walkthrough.** The Operations page, dashboard strip and
  investigation workspace were built and typechecked; the pages were served by
  the Vite dev server but were not clicked through in a browser during this
  report.
- **No load or concurrency testing.** Optimistic concurrency and row locks are
  covered functionally (stale `expectedUpdatedAt` returns `409`), not under
  parallel load.
- **No formal security audit.** Tenant scoping, composite keys, authenticated
  access and cross-organization `404`s are covered by integration tests; no
  penetration test or dependency audit was run.
- **Analysis quality is not measured.** The evaluation is deterministic and
  deliberately does not call a language model; generated summaries and
  hypotheses are therefore not scored.
- **Email/password sign-in through the UI** was not exercised end to end in this
  pass.

---

## 7. Deferred work

- Merging action-item events into the investigation timeline.
- Notifications and assignment emails.
- A resolve confirmation that counts outstanding action items (the backend
  allows resolving with open items; the warning belongs in the UI).
- Cancelled action items, if they turn out to be a real workflow need.
- Evaluation of analysis quality against a labelled set of incidents.

---

## 8. Repository state

- Phase 4 is committed on `main` as focused commits per concern.
- Phase 5 (production readiness) followed it, also on `main`: a bounded pool and
  graceful shutdown, a selectable embedding provider, the single-container
  topology and static web server, the security hardening, ingestion recovery and
  observability, and the CI gates below.
- `.github/workflows/ci.yml` runs the API typecheck and unit tests, the
  integration suite against `pgvector/pgvector:pg16`, the investigation
  evaluation with the embedding fixture stub, the web typecheck and build, a
  build of both Docker images, a dependency audit, and an end-to-end check that
  starts the compose stack and ingests a document through the worker. See §15 of
  [the deployment notes](deployment.md#15-what-ci-checks-before-a-change-reaches-a-deployment).
- `apps/web` lints without errors. The seed script for a demo tenant lives in
  `scripts/seed-demo.mjs`; `docs/deployment.md` covers deploying and seeding.
- `.kilo/` and `stitch_opspilot_ai_product_redesign/` are untouched and remain
  uncommitted.
