import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

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
} from "./harness.js";
import type { TestServer } from "./harness.js";

/**
 * F11 residual: an unknown email must cost the same bcrypt comparison as a
 * wrong password.
 *
 * Response bodies are already identical (asserted in `auth.itest.ts`), so the
 * remaining disclosure channel is timing. This suite measures the real HTTP
 * path rather than calling the service, because the claim is about what an
 * attacker with a stopwatch observes.
 *
 * It lives in its own file on purpose: the auth limiter is in-memory and
 * per-process, and this test issues six failed logins of its own. Sharing the
 * file with the rest of the auth matrix would spend that budget and turn a
 * timing assertion into a 429.
 */

const PASSWORD = "correct horse battery";
const WRONG_PASSWORD = "tr0ubador&3";
const SAMPLES = 3;

let server: TestServer;
let userId: string;
let email: string;

function median(samples: number[]): number {
  return samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
}

async function login(emailAddress: string, password: string) {
  return apiRequest<{ token?: string; error?: string }>(
    server.url,
    "POST",
    "/auth/login",
    { body: { email: emailAddress, password } }
  );
}

async function measure(emailAddress: string, password: string): Promise<number> {
  const startedAt = performance.now();
  const response = await login(emailAddress, password);
  assert.equal(response.status, 401, JSON.stringify(response.body));

  return performance.now() - startedAt;
}

before(async () => {
  await setupTestDatabase();
  server = await startServer();

  await resetDatabase();

  const organizationId = await createOrganization("Timing Org");
  userId = await createUser("timing@example.test");
  await addMembership(userId, organizationId, "owner");

  // A real bcrypt hash at cost 12, the cost the service uses. `createUser`
  // seeds a placeholder hash, which would make the known path a parse failure
  // rather than a comparison.
  const bcrypt = await import("bcrypt");
  const hash = await bcrypt.hash(PASSWORD, 12);

  await getPool().query("UPDATE users SET password_hash = $2 WHERE id = $1", [
    userId,
    hash,
  ]);

  email = "timing@example.test";
});

after(async () => {
  await server?.close();
  if (hasPool()) {
    await getPool().end();
  }
});

describe("login timing", () => {
  it("spends one bcrypt comparison on both failure modes", async () => {
    const wrongPassword: number[] = [];
    const unknownEmail: number[] = [];

    for (let attempt = 0; attempt < SAMPLES; attempt += 1) {
      wrongPassword.push(await measure(email, WRONG_PASSWORD));
      unknownEmail.push(await measure("nobody@example.test", PASSWORD));
    }

    const knownMedian = median(wrongPassword);
    const unknownMedian = median(unknownEmail);

    // bcrypt at cost 12 needs tens of milliseconds even on a fast host. An
    // unknown email that returned before any comparison would be a few
    // milliseconds, so this floor catches the short-circuit without asserting
    // an upper bound that would flake under load.
    assert.ok(
      knownMedian >= 50,
      `the wrong-password path took ${knownMedian.toFixed(1)}ms; expected a real bcrypt comparison`
    );
    assert.ok(
      unknownMedian >= knownMedian * 0.5,
      `unknown-email median ${unknownMedian.toFixed(1)}ms is much faster than ` +
        `wrong-password median ${knownMedian.toFixed(1)}ms`
    );
  });
});
