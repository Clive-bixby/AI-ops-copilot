import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import bcrypt from "bcrypt";

import {
  addMembership,
  apiRequest,
  createOrganization,
  getPool,
  hasPool,
  resetDatabase,
  setupTestDatabase,
  startServer,
} from "./harness.js";
import type { TestServer } from "./harness.js";

/**
 * F18: authentication events have an audit trail.
 *
 * The trail answers "who tried to sign in, and did it work?" without becoming a
 * second copy of the credentials: every line is JSON with a SHA-256 of the
 * normalized email, a user id when one is known, and a reason. The raw address,
 * the password and the issued token must never appear.
 *
 * Logging is captured at the console boundary because that is where the shared
 * logger writes; the assertions parse the real lines the service emitted during
 * real HTTP requests.
 */

const PASSWORD = "correct horse battery";
const WRONG_PASSWORD = "tr0ubador&3";

type LogLine = Record<string, unknown>;

let server: TestServer;
let logs: string[] = [];
const original = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

function identityHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function authLines(): LogLine[] {
  const lines: LogLine[] = [];

  for (const raw of logs) {
    try {
      const parsed = JSON.parse(raw) as LogLine;
      if (typeof parsed.message === "string" && parsed.message.startsWith("auth.")) {
        lines.push(parsed);
      }
    } catch {
      // Request logs and stack traces are not JSON audit lines.
    }
  }

  return lines;
}

function captured(): string {
  return logs.join("\n");
}

function login(email: string, password = PASSWORD) {
  return apiRequest<{ token?: string; error?: string }>(
    server.url,
    "POST",
    "/auth/login",
    { body: { email, password } }
  );
}

function register(email: string) {
  return apiRequest<{ token?: string; error?: string }>(
    server.url,
    "POST",
    "/auth/register",
    { body: { email, password: PASSWORD, organizationName: "Audit Org" } }
  );
}

before(async () => {
  await setupTestDatabase();
  server = await startServer();

  // Installed after migrations and server start, so only request-time lines are
  // captured. Every console level is covered because errors are logged too.
  console.log = ((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  }) as typeof console.log;
  console.warn = console.log;
  console.error = console.log;
});

after(async () => {
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;

  await server?.close();
  if (hasPool()) {
    await getPool().end();
  }
});

let organizationId: string;
let userId: string;
let email: string;

beforeEach(async () => {
  logs = [];
  await resetDatabase();

  organizationId = await createOrganization("Audit Org");
  email = `audit-${Date.now()}@example.test`;

  const hash = await bcrypt.hash(PASSWORD, 4);
  const user = await getPool().query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
    [email, hash]
  );
  userId = user.rows[0]!.id;

  await addMembership(userId, organizationId, "owner");
});

describe("authentication audit trail", () => {
  it("logs a successful login by user id and hashed email, never the credential", async () => {
    const response = await login(email);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.token);

    const succeeded = authLines().filter(
      (line) => line.message === "auth.login_succeeded"
    );

    assert.equal(succeeded.length, 1);
    assert.equal(succeeded[0]!.userId, userId);
    assert.equal(succeeded[0]!.organizationId, organizationId);
    assert.equal(succeeded[0]!.emailHash, identityHash(email));

    const text = captured();
    assert.ok(!text.includes(email), "the raw email must not be logged");
    assert.ok(!text.includes(PASSWORD), "the password must not be logged");
    assert.ok(!text.includes(response.body.token!), "the token must not be logged");
  });

  it("logs both login failure modes identically, by hash only", async () => {
    const wrongPassword = await login(email, WRONG_PASSWORD);
    const unknownEmail = await login("nobody@example.test");
    const unknownAddress = "nobody@example.test";

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);

    const failed = authLines().filter((line) => line.message === "auth.login_failed");

    assert.equal(failed.length, 2, "each attempt has exactly one audit line");

    for (const line of failed) {
      assert.equal(line.reason, "invalid_credentials");
      assert.equal(typeof line.emailHash, "string");
      assert.equal((line.emailHash as string).length, 64);
      // The failure record is not a user record: an unknown address and a wrong
      // password must be indistinguishable in the trail, just as in the body.
      assert.equal(line.userId, undefined);
    }

    assert.deepEqual(
      failed.map((line) => line.emailHash).sort(),
      [identityHash(email), identityHash(unknownAddress)].sort()
    );

    const text = captured();
    assert.ok(!text.includes(email));
    assert.ok(!text.includes(unknownAddress));
    assert.ok(!text.includes(WRONG_PASSWORD));
    assert.ok(!text.includes(PASSWORD));
  });

  it("separates a membership-less login from a credential failure without leaking the address", async () => {
    const orphanEmail = `orphan-${Date.now()}@example.test`;
    const hash = await bcrypt.hash(PASSWORD, 4);
    const orphan = await getPool().query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [orphanEmail, hash]
    );

    const response = await login(orphanEmail);

    assert.equal(response.status, 409);
    assert.equal(response.body.token, undefined);

    const failed = authLines().filter((line) => line.message === "auth.login_failed");

    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.reason, "no_membership");
    assert.equal(failed[0]!.userId, orphan.rows[0]!.id);
    assert.equal(failed[0]!.emailHash, identityHash(orphanEmail));
    assert.ok(!captured().includes(orphanEmail));
  });

  it("audits registration success and a duplicate attempt without naming the address", async () => {
    const registeredEmail = `new-${Date.now()}@example.test`;

    const created = await register(registeredEmail);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const duplicate = await register(registeredEmail);
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error,
      "Registration could not be completed with these details."
    );
    assert.equal(duplicate.body.token, undefined);

    const succeeded = authLines().filter(
      (line) => line.message === "auth.register_succeeded"
    );
    const failed = authLines().filter(
      (line) => line.message === "auth.register_failed"
    );

    assert.equal(succeeded.length, 1);
    assert.equal(succeeded[0]!.emailHash, identityHash(registeredEmail));
    assert.equal(typeof succeeded[0]!.organizationId, "string");
    assert.equal(typeof succeeded[0]!.userId, "string");

    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.reason, "email_conflict");
    assert.equal(failed[0]!.emailHash, identityHash(registeredEmail));

    const text = captured();
    assert.ok(!text.includes(registeredEmail));
    assert.ok(!text.includes(PASSWORD));
    assert.ok(!text.includes(created.body.token!));
  });
});
