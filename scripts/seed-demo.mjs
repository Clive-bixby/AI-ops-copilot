#!/usr/bin/env node
/**
 * Seeds a demo tenant for OpsPilot AI through the running API, so every row goes
 * through the production ingestion path and gets real embeddings.
 *
 *   node scripts/seed-demo.mjs            # seed once (skips if the org has documents)
 *   node scripts/seed-demo.mjs --force    # seed again anyway
 *   API_URL=http://localhost:3000 node scripts/seed-demo.mjs
 *
 * Credentials are printed at the end and are also the constants below.
 *
 * Because every row goes through the production ingestion path, the API needs an
 * embedding provider that can embed text it has never seen: Ollama (the default)
 * or any `openai-compatible` service. `fixture` mode replays recorded vectors
 * only, so it can serve this corpus once seeded but cannot ingest it.
 *
 * The exit code is meaningful: the run ends with a verification summary and exits
 * non-zero when a check fails, so CI can use it as a gate on the demo path.
 */

const API = (process.env.API_URL || "http://localhost:3000").replace(/\/$/, "");
const WEB = (process.env.WEB_URL || "http://localhost:4173").replace(/\/$/, "");
const EMAIL = process.env.SEED_EMAIL || "demo@opspilot.dev";
const PASSWORD = process.env.SEED_PASSWORD || "OpsPilot!Demo2026";
const ORG_NAME = process.env.SEED_ORG || "Northwind Ops (Demo)";
const FORCE = process.argv.includes("--force");

let token = "";
let orgId = "";
let userId = "";

function decodeJwt(token_) {
  const part = token_.split(".")[1];
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

async function call(method, path, body, { raw = false } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (orgId) headers["x-organization-id"] = orgId;

  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const err = new Error(
      `${method} ${path} -> ${res.status} ${typeof data === "string" ? data : JSON.stringify(data)}`
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return raw ? { res, data } : data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- account ----
async function signInOrRegister() {
  try {
    const out = await call("POST", "/auth/register", {
      email: EMAIL,
      password: PASSWORD,
      organizationName: ORG_NAME,
    });
    token = out.token;
    console.log(`registered ${EMAIL}`);
  } catch (error) {
    if (error.status !== 409 && error.status !== 400) throw error;
    const out = await call("POST", "/auth/login", {
      email: EMAIL,
      password: PASSWORD,
    });
    token = out.token;
    console.log(`signed in as existing ${EMAIL}`);
  }

  const claims = decodeJwt(token);
  orgId = claims.organizationId;
  userId = claims.userId || claims.id || claims.sub || "";

  if (!orgId) throw new Error("Token has no organizationId claim");
  if (!userId) {
    const members = await call("GET", "/organization/members");
    const list = members.members || members;
    const me = (Array.isArray(list) ? list : []).find(
      (m) => (m.email || "").toLowerCase() === EMAIL
    );
    if (me) userId = me.userId || me.id || me.user_id || "";
  }

  console.log(`organization ${orgId}`);
}

// --------------------------------------------------------------- documents ---
const documents = [
  {
    filename: "checkout-service-runbook.md",
    content: `# Checkout service runbook

The checkout service calls the payment gateway over HTTPS. It owns a Postgres
connection pool capped at 20 connections per instance and a Redis-backed retry
queue for gateway retries.

## Gateway timeouts

Gateway timeouts show up as \`UPSTREAM_TIMEOUT\` after 8 seconds. Before paging
the payments team, check whether the pool is saturated: a saturated connection
pool makes every downstream call look slow. Raise the client timeout to 12
seconds only after the pool has headroom, never as a first fix.

Retries are capped at three with exponential backoff starting at 200 ms. A
retry storm during peak traffic multiplies load on the gateway, so when the
timeout rate passes 2% of requests, disable retries for the duration of the
incident.

## Health checks

\`/health\` is liveness and does no I/O. \`/ready\` checks Postgres and Redis and
returns 503 when either is unreachable. The load balancer removes an instance
after three failed readiness probes.

## Rollback

Deployments are immutable containers. A rollback re-points the service to the
previous image tag; it does not revert database migrations. See the deployment
rollback runbook for the migration rule.
`,
  },
  {
    filename: "deployment-rollback.md",
    content: `# Deployment rollback procedure

A rollback restores the previous application image. Database migrations are
never rolled back automatically, because a destructive down-migration can lose
data that the previous release cannot reconstruct.

## When to roll back

Roll back when the error rate for the new release exceeds the previous hour's
baseline by more than three times and the cause is in application code. Do not
roll back for a dependency outage: the previous image calls the same dependency.

## Steps

1. Freeze deploys on the affected service.
2. Identify the last known good image tag from the release log.
3. Re-point the service and wait for two consecutive passing readiness probes.
4. Verify the checkout smoke test: create a test order, confirm the gateway
   authorises it, and refund it.
5. Announce the rollback in the incident channel with the image tag and the
   observed error signature.

## Migrations

If the release included a migration, the previous image must still tolerate the
new schema. Additive migrations are safe; a column rename needs an expand and
contract across two releases.
`,
  },
  {
    filename: "incident-response.md",
    content: `# Incident response

## Severity levels

- SEV1: checkout or payments unavailable for any customer. Page immediately.
- SEV2: degraded checkout, elevated latency, or one region impaired. Page the
  on-call engineer during business hours, notify otherwise.
- SEV3: a single workflow is broken with a workaround. Open a ticket.
- SEV4: cosmetic or internal-only impact. Backlog.

## Lifecycle

An incident starts as an investigation, moves to investigating once an owner is
assigned, and closes only after a written resolution summary exists. A closed
incident rejects metadata edits until it is reopened, which keeps the record of
what happened stable for the postmortem.

## Communication

Post an update every 30 minutes for SEV1 and every 2 hours for SEV2. Updates
state customer impact, current hypothesis and the next action with an owner.

## Postmortem

Blameless, within five business days. It lists the timeline, contributing
factors, the detection gap and follow-up action items with an owner and a due
date. Action items live on the investigation record; a postmortem that only
lives in a document is not tracked work.
`,
  },
  {
    filename: "postgres-capacity-and-pgvector.md",
    content: `# Postgres capacity and pgvector maintenance

## Connection pool

Each API instance opens at most 20 connections, each worker 10. Keep the total
below 80% of the server's max_connections. When the pool is exhausted, requests
queue and then fail with \`pool timeout\` after 5 seconds; that failure looks
like a slow dependency but it is local saturation.

## Slow queries

The retrieval path queries \`source_chunks\` by cosine distance. The HNSW index
needs \`maintenance_work_mem\` of at least 64 MB during a rebuild, and a rebuild
takes write locks on inserts. Rebuild in a maintenance window, not during peak
checkout traffic.

## Replication lag

Read replicas lag by up to 400 ms under normal load. Do not read a record you
just wrote from a replica; the write-then-read pattern needs the primary.

## Vacuum

Autovacuum is tuned for the logs table, which receives the largest insert
volume. If dead tuples exceed 20% on \`source_chunks\`, run a manual vacuum
analyze before investigating retrieval quality.
`,
  },
  {
    filename: "redis-and-ingestion-queue.md",
    content: `# Redis and the ingestion queue

Ingestion jobs are queued in BullMQ on Redis and drained by the worker. The API
accepts an upload, records a job row and returns 202; the worker parses, chunks,
embeds and indexes the text.

## Queue depth

A rising waiting count with an active count of zero means nothing is consuming
the queue: check the worker heartbeat. A queue with waiting jobs proves nothing
about whether a worker is alive.

## Worker heartbeats

The worker writes a heartbeat key with a 45 second TTL. \`missing\` means no
worker has reported for 45 seconds. \`stale\` means the last beat is older than
expected but present.

## Stuck jobs

A job left in \`running\` after the worker dies is swept after ten minutes and
either requeued or failed with a reason. If a document has been \`pending\` for
longer than that, the worker is not running.

## Failover

After a Redis failover the queue is rebuilt from the ledger. Jobs that were
active at failover are requeued under the same job id so the same source cannot
be indexed twice concurrently.
`,
  },
  {
    filename: "access-control-and-onboarding.md",
    content: `# Access control and onboarding

## Roles

- owner: full access, including member management and billing.
- admin: manage members and settings, but not ownership transfer.
- member: work on documents, tickets, logs and investigations.

Tenant scoping is enforced by membership: the organization id on every request
must match a membership row for the signed-in user. A user with no membership in
an organization cannot read that organization's rows, and the API does not fall
back to an id from the token.

## Onboarding checklist

1. Invite the engineer with the member role.
2. Add them to the on-call rotation.
3. Verify they can read the runbooks and open an investigation.

## Break-glass access

Break-glass is a time-boxed owner grant, approved by two owners and logged in
the audit record. It expires automatically after four hours. It is for a SEV1
only and is never used for convenience.

## Offboarding

Remove the membership, rotate any shared secret the person could read, and
record the removal in the incident log if the person was on call.
`,
  },
];

async function uploadDocuments(existingFilenames) {
  let uploaded = 0;
  for (const doc of documents) {
    if (existingFilenames.has(doc.filename)) {
      console.log(`  exists ${doc.filename}`);
      continue;
    }
    const form = new FormData();
    form.append(
      "file",
      new Blob([doc.content], { type: "text/markdown" }),
      doc.filename
    );
    try {
      await call("POST", "/documents/upload", form);
      uploaded += 1;
      console.log(`  uploaded ${doc.filename}`);
    } catch (error) {
      console.log(`  upload failed ${doc.filename}: ${error.message}`);
    }
  }
  return uploaded;
}

// ----------------------------------------------------------------- tickets ---
const tickets = [
  {
    title: "Checkout returns 502 after the 19 Nov deploy",
    description:
      "Customers see a 502 on the payment step within seconds of submitting card details. Started right after release 2026.11.19-3. Rollback candidate.",
    status: "in_progress",
    priority: "urgent",
  },
  {
    title: "Payment gateway timeouts at peak",
    description:
      "UPSTREAM_TIMEOUT errors from the gateway between 18:00 and 19:00 UTC. Timeout rate reached 4.1% of authorisations, retries amplified load.",
    status: "open",
    priority: "high",
  },
  {
    title: "Webhook backlog after Redis failover",
    description:
      "Stripe webhooks delayed by up to 40 minutes while the queue was rebuilt. No events lost, delivery resumed after the failover.",
    status: "resolved",
    priority: "high",
  },
  {
    title: "Dashboard slow for large organizations",
    description:
      "Operations overview takes 6 seconds for an organization with 40k log rows. Suspected missing index on organization_id plus status.",
    status: "open",
    priority: "medium",
  },
  {
    title: "MFA reset request for departed contractor",
    description:
      "Former contractor still has an active account. Need to remove the membership and rotate the shared deploy key.",
    status: "pending",
    priority: "high",
  },
  {
    title: "Refund job fails for partial refunds",
    description:
      "Batch refund worker throws a decimal parse error on partial refunds under one dollar. Full refunds are unaffected.",
    status: "in_progress",
    priority: "medium",
  },
  {
    title: "Ingestion stuck in pending for PDF uploads",
    description:
      "Two uploaded PDFs stayed pending for an hour. Worker heartbeat was missing, so nothing was consuming the queue.",
    status: "resolved",
    priority: "high",
  },
  {
    title: "Search returns nothing for a short query",
    description:
      "Query '502' returns no results although the error appears in logs. Similarity floor probably filters short queries out.",
    status: "open",
    priority: "low",
  },
  {
    title: "Add severity column to the ticket matrix",
    description:
      "Ops asked for priority to be visible in the matrix without opening each ticket.",
    status: "closed",
    priority: "low",
  },
  {
    title: "Latency spike on the auth service",
    description:
      "p99 login latency rose from 180 ms to 900 ms after enabling stricter rate limiting on credential endpoints.",
    status: "open",
    priority: "medium",
  },
  {
    title: "Connection pool exhausted during nightly batch",
    description:
      "API instances hit pool timeout at 02:00 when the nightly reconciliation job runs. The batch shares the same pool.",
    status: "in_progress",
    priority: "urgent",
  },
  {
    title: "Log ingest rejects JSON with a nested metadata object",
    description:
      "A customer pipeline sends nested metadata; the ingest endpoint answers 201 but metadata arrives flattened.",
    status: "pending",
    priority: "low",
  },
  {
    title: "Document reprocess answers 409",
    description:
      "Reprocess returns source_file_unavailable after a provider change. Expected: the upload was deleted once text was extracted.",
    status: "closed",
    priority: "low",
  },
  {
    title: "Postmortem missing for the SEV1 on 12 Nov",
    description:
      "The SEV1 checkout outage has an investigation but no follow-up action items yet.",
    status: "open",
    priority: "medium",
  },
];

const logs = [
  ["error", "checkout-api", "UPSTREAM_TIMEOUT gateway=stripe attempt=1 elapsed=8002ms order=ord_88213"],
  ["error", "checkout-api", "UPSTREAM_TIMEOUT gateway=stripe attempt=2 elapsed=8001ms order=ord_88214"],
  ["error", "checkout-api", "UPSTREAM_TIMEOUT gateway=stripe attempt=3 elapsed=8004ms order=ord_88215"],
  ["fatal", "checkout-api", "circuit breaker opened for stripe after 25 consecutive timeouts"],
  ["error", "payment-worker", "retry storm detected: 312 retries in 60s against the gateway"],
  ["warn", "checkout-api", "connection pool saturation: 20/20 connections in use, 41 queued"],
  ["warn", "checkout-api", "pool timeout after 5000ms waiting for a connection"],
  ["error", "checkout-api", "HTTP 502 returned to client for POST /checkout/confirm"],
  ["info", "deploy-bot", "release 2026.11.19-3 rolled out to checkout-api"],
  ["warn", "deploy-bot", "readiness probe failed once for checkout-api revision 3, retry succeeded"],
  ["fatal", "checkout-api", "health check failed: readiness returned 503 database unreachable"],
  ["warn", "postgres", "replication lag 420ms on read replica checkout-ro-1"],
  ["error", "worker", "ingestion job failed: source file was deleted before text extraction"],
  ["info", "worker", "ingestion job succeeded document=runbook chunks=9"],
  ["debug", "worker", "heartbeat written ttl=45s"],
  ["warn", "worker", "no heartbeat for 50s, queue depth 7 waiting"],
  ["info", "redis", "failover complete, replica promoted in 3.4s"],
  ["warn", "redis", "queue rebuilt from ledger after failover, 12 jobs requeued"],
  ["error", "webhook-dispatcher", "delivery delayed 2400s for stripe event evt_5512"],
  ["info", "webhook-dispatcher", "backlog cleared, 812 events delivered"],
  ["warn", "admin-api", "break-glass grant requested by user for SEV1 checkout outage"],
  ["info", "admin-api", "break-glass grant expired after 4 hours"],
  ["error", "refunds", "decimal parse error on partial refund amount 0.85"],
  ["warn", "refunds", "refund batch retried with 12 failures held for review"],
  ["error", "auth-api", "credential endpoint rate limit hit for 18 requests from one IP"],
  ["warn", "auth-api", "p99 login latency 900ms, above the 400ms target"],
  ["info", "search-api", "hybrid retrieval query completed results=5 keywordOnly=2"],
  ["debug", "search-api", "similarity floor filtered 14 candidates below 0.65"],
  ["error", "batch-reconciliation", "pool timeout after 5000ms during nightly run"],
  ["warn", "batch-reconciliation", "nightly job held 12 connections for 40 minutes"],
  ["info", "checkout-api", "checkout smoke test passed after rollback to revision 2"],
  ["warn", "checkout-api", "error rate 4.1% above 2% retry-disable threshold"],
];

function iso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function buildLogs() {
  return logs.map(([level, service, message], index) => ({
    level,
    message,
    timestamp: iso(240 - index * 6),
    service,
    environment: "production",
  }));
}

async function ingestTickets() {
  const out = await call("POST", "/tickets/ingest", tickets);
  console.log(`  ingesting ${out.count} tickets, jobs queued ${out.jobsQueued}`);
}

async function ingestLogs() {
  const out = await call("POST", "/logs/ingest", buildLogs());
  console.log(
    `  ingesting ${out.count} logs, groups touched ${out.groupsTouched}, jobs queued ${out.jobsQueued}`
  );
}

// --------------------------------------------------------------- ingestion ---
async function waitForIngestion(timeoutMs = 180_000) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const docs = await call("GET", "/documents");
    const list = Array.isArray(docs) ? docs : docs.documents || [];
    const pending = list.filter((d) =>
      ["pending", "processing", "queued"].includes(d.processingStatus)
    );
    const line = `  documents: ${list.length} total, ${pending.length} processing`;
    if (line !== last) {
      console.log(line);
      last = line;
    }
    if (pending.length === 0 && list.length > 0) return list;
    await sleep(4000);
  }
  console.log("  ! ingestion still running after the wait; continuing");
  return [];
}

// ---------------------------------------------------------- investigations ---
/** Reuses an investigation with the same title, so a re-run does not duplicate. */
const existingInvestigations = new Map();

async function loadInvestigations() {
  const out = await call("GET", "/investigations?limit=50");
  const list = out.investigations || out.items || out;
  for (const item of Array.isArray(list) ? list : []) {
    existingInvestigations.set(item.title, item.id);
  }
}

async function createInvestigation(payload) {
  const reuse = existingInvestigations.get(payload.title);
  if (reuse) {
    console.log(`  exists "${payload.title}"`);
    return reuse;
  }
  const out = await call("POST", "/investigations", payload);
  const id = out.investigation ? out.investigation.id : out.id;
  existingInvestigations.set(payload.title, id);
  return id;
}

/** Notes and comments are best-effort: the route set depends on the image build. */
async function tryPost(path, body, label) {
  try {
    await call("POST", path, body);
  } catch (error) {
    console.log(`  ! ${label} unavailable: ${error.message}`);
  }
}

async function seedInvestigations() {
  const results = {};

  const sev1 = await createInvestigation({
    title: "Checkout 502 spike after release 2026.11.19-3",
    description:
      "Checkout returned 502 for roughly 4% of confirmations immediately after the 19 Nov release. The circuit breaker for the gateway opened after 25 consecutive upstream timeouts, and the connection pool was saturated.",
    severity: "critical",
    service: "checkout-api",
    errorSignature: "UPSTREAM_TIMEOUT gateway=stripe attempt=1 elapsed=8002ms",
    windowStart: iso(300),
    windowEnd: iso(60),
    sourceTypes: ["document", "log", "ticket"],
    collectEvidence: true,
  });
  results.sev1 = sev1;
  console.log(`  investigation (critical, investigating): ${sev1}`);

  await tryPost(`/investigations/${sev1}/notes`, {
    body: "Rolled back to revision 2 at 14:20 UTC; error rate returned to baseline within six minutes. Pool saturation cleared on its own once retries stopped.",
  }, "notes");
  await tryPost(`/investigations/${sev1}/comments`, {
    body: "Confirming the gateway itself was healthy throughout: its status page showed no incidents, so this was our retry amplification.",
  }, "comments");
  await call("PATCH", `/investigations/${sev1}`, { status: "investigating" });

  const items = [
    {
      title: "Write the guarded rollback decision into the runbook",
      description:
        "Document the rule that a retry storm above 2% disables retries before a rollback is considered.",
      priority: "high",
      dueAt: iso(-3 * 24 * 60),
      status: "completed",
    },
    {
      title: "Add connection pool saturation to the checkout dashboard",
      description:
        "Pool in-use and queued connections per instance, with an alert at 80% of the cap.",
      priority: "medium",
      dueAt: iso(-2 * 24 * 60),
      status: "in_progress",
    },
    {
      title: "Cap gateway retries at peak with a feature flag",
      description:
        "The retry count is a deployment constant today; make it runtime-configurable per environment.",
      priority: "critical",
      dueAt: iso(-1 * 24 * 60),
      status: "blocked",
      blockedReason:
        "Waiting on the payments team to approve the flag name and default before the change ships.",
    },
    {
      title: "Re-run the checkout smoke test against revision 2",
      description: "Create, authorise and refund a test order on both instances.",
      priority: "low",
      dueAt: iso(2 * 24 * 60),
      status: "open",
    },
  ];

  const existingItems = await call("GET", `/investigations/${sev1}/action-items`);
  const itemList = existingItems.items || existingItems.actionItems || existingItems;
  const byTitle = new Map(
    (Array.isArray(itemList) ? itemList : []).map((i) => [i.title, i])
  );

  for (const item of items) {
    const existing = byTitle.get(item.title);
    let itemId = existing?.id;

    if (existing) {
      console.log(
        `  action item "${item.title}" exists (${existing.status})`
      );
    } else {
      const created = await call("POST", `/investigations/${sev1}/action-items`, {
        title: item.title,
        description: item.description,
        priority: item.priority,
        dueAt: item.dueAt,
      });
      itemId = created.item ? created.item.id : created.id;
    }

    // Reused items still need their target status, so a re-run repairs a partial seed.
    if ((existing?.status ?? "open") !== item.status) {
      await call("PATCH", `/investigations/${sev1}/action-items/${itemId}`, {
        status: item.status,
        ...(item.blockedReason ? { blockedReason: item.blockedReason } : {}),
      });
    }
  }
  console.log(`  added 4 action items (completed, in_progress, blocked, open/overdue)`);

  const gateway = await createInvestigation({
    title: "Payment gateway timeouts during the evening peak",
    description:
      "Between 18:00 and 19:00 UTC the gateway timeout rate reached 4.1% of authorisations. Retries multiplied load and pushed p99 checkout latency past 8 seconds.",
    severity: "high",
    service: "payments-gateway",
    errorSignature: "circuit breaker opened for stripe after 25 consecutive timeouts",
    sourceTypes: ["document", "ticket"],
    collectEvidence: true,
  });
  results.gateway = gateway;
  console.log(`  investigation (high, open): ${gateway}`);

  await call("POST", `/investigations/${gateway}/action-items`, {
    title: "Agree the peak-hour retry budget with the payments team",
    description: "Decide the retry ceiling for peak traffic and record it in the runbook.",
    priority: "high",
    dueAt: iso(-5 * 24 * 60),
  });

  const webhook = await createInvestigation({
    title: "Webhook backlog after the Redis failover",
    description:
      "Stripe webhooks were delayed up to 40 minutes while the queue was rebuilt from the ledger after a Redis replica promotion. No events were lost.",
    severity: "medium",
    service: "webhook-dispatcher",
    sourceTypes: ["document", "log", "ticket"],
    collectEvidence: true,
  });
  results.webhook = webhook;
  console.log(`  investigation (medium): ${webhook}`);

  await tryPost(`/investigations/${webhook}/notes`, {
    body: "Backlog drained 43 minutes after the promotion. Delivery was retried from the ledger, so nothing needed replaying by hand.",
  }, "notes");
  // `open -> resolved` is not a legal transition. Evidence collection promotes a
  // new investigation to `investigating` when it adds something, and this used to
  // depend on that having happened; say it explicitly. Re-applying the current
  // status is accepted, so this is also correct on a re-run, where the
  // investigation may already be resolved or promoted.
  await call("PATCH", `/investigations/${webhook}`, { status: "investigating" });
  await call("PATCH", `/investigations/${webhook}`, {
    status: "resolved",
    resolutionSummary:
      "Resolved by rebuilding the queue from the ledger and letting the dispatcher drain it. Added a queue-depth alert at 500 waiting events so the next failover is noticed in minutes.",
  });

  return results;
}

// ------------------------------------------------------------------ checks ---
async function verify() {
  const checks = [];
  const failures = [];
  const docs = await call("GET", "/documents");
  const docList = Array.isArray(docs) ? docs : docs.documents || [];
  const statusCounts = docList.reduce(
    (acc, d) => ({ ...acc, [d.processingStatus]: (acc[d.processingStatus] || 0) + 1 }),
    {}
  );
  checks.push(`documents: ${docList.length} ${JSON.stringify(statusCounts)}`);
  if (docList.length === 0) failures.push("no documents were indexed");

  const ticketsOut = await call("GET", "/tickets");
  const ticketList = Array.isArray(ticketsOut) ? ticketsOut : ticketsOut.tickets || [];
  checks.push(`tickets: ${ticketList.length}`);
  if (ticketList.length === 0) failures.push("no tickets were ingested");

  const logsOut = await call("GET", "/logs");
  const logList = Array.isArray(logsOut) ? logsOut : logsOut.logs || [];
  checks.push(`logs: ${logList.length}`);
  if (logList.length === 0) failures.push("no logs were ingested");

  const investigationsOut = await call("GET", "/investigations");
  const invList =
    investigationsOut.investigations || investigationsOut.items || investigationsOut;
  const investigationCount = Array.isArray(invList) ? invList.length : 0;
  checks.push(`investigations: ${investigationCount}`);
  if (investigationCount < 3) failures.push(`expected 3 investigations, found ${investigationCount}`);

  try {
    const ops = await call("GET", "/insights/operations");
    checks.push(`operations overview: ${JSON.stringify(ops).slice(0, 180)}`);
  } catch (error) {
    checks.push(`operations overview failed: ${error.message}`);
    failures.push(`operations overview failed: ${error.message}`);
  }

  try {
    const search = await call("POST", "/ai/search", {
      query: "how do I roll back a bad deployment",
      limit: 3,
    });
    const results = Array.isArray(search.results) ? search.results : [];
    checks.push(
      `search: ${results.length} hits (${results.map((r) => r.matchType).join(", ")})`
    );
    if (results.length === 0) {
      failures.push("search returned no hits for a runbook question");
    }
  } catch (error) {
    checks.push(`search failed: ${error.message}`);
    failures.push(`search failed: ${error.message}`);
  }

  console.log("\nverification:");
  for (const line of checks) console.log(`  - ${line}`);

  if (failures.length > 0) {
    throw new Error(`verification failed:\n  - ${failures.join("\n  - ")}`);
  }
}

// -------------------------------------------------------------------- main ---
async function main() {
  console.log(`seeding ${API}\n`);
  await signInOrRegister();

  const existing = await call("GET", "/documents");
  const existingList = Array.isArray(existing) ? existing : existing.documents || [];
  const existingFilenames = new Set(existingList.map((d) => d.filename));

  console.log("\ndocuments:");
  await uploadDocuments(existingFilenames);

  const existingTickets = await call("GET", "/tickets");
  const ticketList = Array.isArray(existingTickets)
    ? existingTickets
    : existingTickets.tickets || [];
  if (ticketList.length === 0 || FORCE) {
    console.log("\ntickets:");
    await ingestTickets();
    console.log("\nlogs:");
    await ingestLogs();
  } else {
    console.log(`\ntickets: ${ticketList.length} already present, skipping ticket/log ingest`);
  }

  console.log("\nwaiting for ingestion:");
  await waitForIngestion();

  console.log("\ninvestigations:");
  await loadInvestigations();
  await seedInvestigations();

  await verify();

  console.log(`
done.

  web:      ${WEB}
  api:      ${API}
  email:    ${EMAIL}
  password: ${PASSWORD}
  org:      ${ORG_NAME} (${orgId})
`);
}

main().catch((error) => {
  console.error(`\nseed failed: ${error.stack || error.message}`);
  process.exit(1);
});
