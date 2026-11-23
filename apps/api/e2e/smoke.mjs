#!/usr/bin/env node
import { randomUUID } from "node:crypto";

/**
 * End-to-end check for the deployed topology.
 *
 * Every earlier suite tests a layer: unit tests the functions, the integration
 * suite the SQL against a real pgvector, the evaluation the retrieval quality.
 * None of them proves that the two images, one container, a supervisor, Postgres,
 * Redis, a worker and a web build work together -- which is exactly what a
 * deployment is.
 *
 * This drives the running stack over HTTP as a user would: sign up, sign in,
 * upload a document, wait for the worker to index it, then find it by search.
 * Tenant isolation and CORS are checked in the same pass because they are the
 * failures that unit tests cannot see (a middleware missing from one route).
 *
 * Start the stack first:
 *
 *   JWT_SECRET=$(openssl rand -hex 32) \
 *     docker compose -f docker-compose.single.yml -f docker-compose.e2e.yml up -d --build
 *   node apps/api/e2e/smoke.mjs
 *
 * The embedding stub in this directory makes the upload embeddable without a
 * model; see `docker-compose.e2e.yml`.
 */

const API_URL = (process.env.E2E_API_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const WEB_URL = (process.env.E2E_WEB_URL ?? "http://127.0.0.1:4173").replace(/\/$/, "");
const ALLOWED_ORIGIN = process.env.E2E_ALLOWED_ORIGIN ?? "http://localhost:4173";

/** Migrations plus two process starts; a cold runner is slow but not this slow. */
const STARTUP_TIMEOUT_MS = 180_000;
const INGESTION_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

/** Enough prose to survive the chunker's minimum-token floor. */
const RUNBOOK = `Checkout latency runbook

When checkout latency rises, first confirm the problem is real and not a
dashboard artefact. Compare p95 latency for the last hour against the same hour
last week; a weekday morning is not comparable to a Sunday night.

If the increase is real, check the payment provider status page before touching
anything on our side. A degraded provider shows up as slow authorisations and
then as timeouts in checkout-api, and rolling back a deploy that is not at fault
only adds an incident.

When the provider is healthy, look at the connection pool. Checkout-api holds a
bounded pool, and when every connection is busy the queue behind it grows until
requests hit the gateway timeout. The pool metric to watch is wait time, not
utilization: utilization at ninety percent is normal during a sale, wait time
above fifty milliseconds is not.

Then check the database itself. Long running queries from reporting jobs compete
with checkout for connections. If a reporting query has been running for more
than a minute, cancel it, and schedule reporting outside peak hours.

If none of these explain the latency, capture a flame graph from one instance
for thirty seconds during the slow period and compare it with a capture from a
healthy period. The comparison is what identifies the change; a single profile
only tells you where time goes, not what changed.

After the incident, write down the trigger and the fix in this runbook. A runbook
that is not updated after an incident is a document nobody trusts next time.
`;

function log(message) {
  console.log(`[e2e] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`${url} was not ready within ${timeoutMs}ms (last: ${last})`);
}

async function request(path, { method = "GET", token, organizationId, body, headers = {} } = {}) {
  return fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(organizationId ? { "x-organization-id": organizationId } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function bodyOf(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function decodeClaims(token) {
  const [, payload] = token.split(".");
  assert(payload, "the server returned a token that is not a JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

async function main() {
  log(`API ${API_URL}, web ${WEB_URL}`);

  // 1. The container is up: Postgres answers, so /ready is 200 rather than the
  //    503 the image reports when its database is unreachable.
  const ready = await waitForReady(`${API_URL}/ready`, STARTUP_TIMEOUT_MS);
  const readiness = await bodyOf(ready);
  assert(readiness.checks?.database?.status === "up", "/ready did not report the database as up");
  log(`ready: database up, redis ${readiness.checks?.redis?.status ?? "unknown"}`);

  // 2. The web image serves the built app shell, not a directory listing or a
  //    404 page: the runtime stage has no node_modules, so this is the only
  //    place that proves `server.mjs` found `dist`.
  const shell = await waitForReady(`${WEB_URL}/`, 60_000);
  const shellType = shell.headers.get("content-type") ?? "";
  const shellHtml = await shell.text();
  assert(shellType.includes("text/html"), `the web image served ${shellType} for /`);
  assert(shellHtml.includes('id="root"'), "the web image did not serve the app shell");
  log("web: app shell served");

  // 3. Sign up. Registration creates the user, the organization and an owner
  //    membership in one transaction and returns a token for all three.
  const email = `e2e-${randomUUID()}@example.test`;
  const password = "e2e-password-123";
  const registered = await request("/auth/register", {
    method: "POST",
    body: { email, password, organizationName: "E2E Organization" },
  });
  const registration = await bodyOf(registered);
  assert(
    registered.status === 201,
    `register returned ${registered.status}: ${JSON.stringify(registration)}`
  );
  const organizationId = decodeClaims(registration.token).organizationId;
  assert(organizationId, "the issued token carries no organizationId");

  // 4. Sign in again -- the path a returning user takes -- and confirm the token
  //    resolves to the same tenant.
  const login = await request("/auth/login", { method: "POST", body: { email, password } });
  assert(login.status === 200, `login returned ${login.status}`);
  const { token } = await bodyOf(login);
  assert(decodeClaims(token).organizationId === organizationId, "login issued a token for a different organization");

  const me = await request("/auth/me", { token, organizationId });
  assert(me.status === 200, `/auth/me returned ${me.status}`);
  const session = await bodyOf(me);
  assert(session.organization?.id === organizationId, "/auth/me returned the wrong organization");
  assert(session.user?.email === email, "/auth/me returned the wrong user");
  log("auth: register, login and session agree");

  // 5. Upload. 202 means the row exists and the job is queued; the worker in the
  //    same container is what turns it into searchable chunks.
  const form = new FormData();
  form.set("file", new Blob([RUNBOOK], { type: "text/plain" }), "checkout-runbook.txt");

  const uploaded = await fetch(`${API_URL}/documents/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-organization-id": organizationId },
    body: form,
  });
  const uploadBody = await bodyOf(uploaded);
  assert(uploaded.status === 202, `upload returned ${uploaded.status}: ${JSON.stringify(uploadBody)}`);

  const documentId = uploadBody.id;
  assert(documentId, "the upload response carries no document id");
  log(`upload: queued document ${documentId}`);

  // 6. Wait for the worker. Polling the document rather than the queue is what a
  //    user sees, and it fails with the recorded reason instead of a timeout when
  //    ingestion fails.
  const ingestionDeadline = Date.now() + INGESTION_TIMEOUT_MS;
  let document = null;

  while (Date.now() < ingestionDeadline) {
    const response = await request(`/documents/${documentId}`, { token, organizationId });
    assert(response.status === 200, `GET /documents/${documentId} returned ${response.status}`);
    document = await bodyOf(response);

    if (document.processingStatus === "processed" || document.processingStatus === "failed") {
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  assert(document !== null, "the document was never readable");
  assert(
    document.processingStatus === "processed",
    `ingestion ended as "${document.processingStatus}": ${document.processingError ?? "no reason recorded"}`
  );
  assert(document.chunkCount >= 1, "the document was processed but no chunks were stored");
  log(`ingestion: processed with ${document.chunkCount} chunk(s)`);

  // 7. The chunks must be findable, and the answer must name the document that
  //    was just uploaded.
  const search = await request("/ai/search", {
    method: "POST",
    token,
    organizationId,
    body: { query: "checkout latency connection pool wait time", limit: 5 },
  });
  assert(search.status === 200, `/ai/search returned ${search.status}`);
  const results = await bodyOf(search);
  assert(results.totalResults >= 1, "search returned no results for the uploaded document");
  assert(
    results.results.some((result) => result.sourceId === documentId),
    "search results do not include the uploaded document"
  );
  log(`search: ${results.totalResults} result(s), uploaded document ranked`);

  // 8. The worker heartbeat is the "is ingestion actually being worked on" signal
  //    from the observability endpoint; a stack whose queue is drained by nobody
  //    would have passed the upload above.
  const ingestionHealth = await request("/ingestion/health", { token, organizationId });
  assert(ingestionHealth.status === 200, `/ingestion/health returned ${ingestionHealth.status}`);
  const health = await bodyOf(ingestionHealth);
  assert(health.worker?.status === "up", `ingestion worker reported "${health.worker?.status}"`);
  log("worker: heartbeat up");

  // 9. Anonymous access is refused, and a token for one tenant cannot read
  //    another tenant's document.
  const anonymous = await request("/documents");
  assert(anonymous.status === 401, `anonymous GET /documents returned ${anonymous.status}`);

  const foreignTenant = await request(`/documents/${documentId}`, {
    token,
    organizationId: randomUUID(),
  });
  assert(foreignTenant.status === 403, `a foreign organization got ${foreignTenant.status} instead of 403`);
  log("isolation: anonymous 401, foreign tenant 403");

  // 10. CORS: the configured web origin is allowed and an arbitrary one gets no
  //     allow header (the request still succeeds -- the browser is what blocks
  //     the response).
  const allowed = await fetch(`${API_URL}/health`, { headers: { origin: ALLOWED_ORIGIN } });
  assert(
    allowed.headers.get("access-control-allow-origin") === ALLOWED_ORIGIN,
    `the configured origin ${ALLOWED_ORIGIN} was not allowed`
  );

  const denied = await fetch(`${API_URL}/health`, { headers: { origin: "https://not-allowed.example" } });
  assert(
    !denied.headers.get("access-control-allow-origin"),
    "an unconfigured origin received an Access-Control-Allow-Origin header"
  );
  log("cors: configured origin allowed, unconfigured origin refused");

  log("passed");
}

main().catch((error) => {
  console.error(`[e2e] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
