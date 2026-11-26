import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

/**
 * The AI budget is read from the environment when the limiter is created, and
 * the harness imports the app lazily inside `startServer()`, so setting it here
 * (before any test runs) is enough. Three requests keeps the test quick.
 */
process.env.AI_RATE_LIMIT_MAX = "3";

import {
  addMembership,
  apiRequest,
  createOrganization,
  createUser,
  getPool,
  hasPool,
  resetDatabase,
  setupTestDatabase,
  startServer,
  tokenFor,
} from "./harness.js";
import type { TestServer } from "./harness.js";

/**
 * Generation routes are the ones that spend provider quota. This test proves
 * three things the audit asked for: the AI budget actually rejects, the
 * rejection is a 429 with an actionable body, and ordinary routes and the
 * health probe are not caught by it.
 *
 * The requests carry an empty query, which the controller rejects with 400
 * before any provider call. That keeps the test deterministic and offline: the
 * limiter runs first, so the budget is still consumed on every attempt, and the
 * assertion never depends on which embedding backend the machine has.
 */

let server: TestServer;
let organizationId: string;
let userId: string;

function auth() {
  return { token: tokenFor(userId), organizationId };
}

async function search() {
  return apiRequest<{ error?: string }>(server.url, "POST", "/ai/search", {
    ...auth(),
    body: { query: "", limit: 3 },
  });
}

before(async () => {
  await setupTestDatabase();
  server = await startServer({ disableRateLimit: false });
});

after(async () => {
  await server?.close();
  if (hasPool()) {
    await getPool().end();
  }
});

describe("AI rate limit", () => {
  before(async () => {
    await resetDatabase();
    organizationId = await createOrganization("Rate Limit Org");
    userId = await createUser("rate-limit@example.test");
    await addMembership(userId, organizationId, "owner");
  });

  it("allows the budget, then rejects with 429 and an actionable message", async () => {
    const allowed = [await search(), await search(), await search()];
    const limited = await search();

    for (const response of allowed) {
      // Validated and rejected by the controller, not by the limiter.
      assert.equal(response.status, 400, JSON.stringify(response.body));
    }

    assert.equal(limited.status, 429);
    assert.match(limited.body.error ?? "", /too many AI requests/i);
  });

  it("does not spend the AI budget on reads or the health probe", async () => {
    const documents = await apiRequest(server.url, "GET", "/documents", auth());
    const health = await apiRequest<{ healthy: boolean }>(
      server.url,
      "GET",
      "/ai/health"
    );

    assert.equal(documents.status, 200);
    assert.notEqual(health.status, 429);
    assert.equal(typeof health.body.healthy, "boolean");
  });
});
