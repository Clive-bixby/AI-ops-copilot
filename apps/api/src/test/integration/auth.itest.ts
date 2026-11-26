import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

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
 * Authentication and session tests at the HTTP boundary.
 *
 * These exist because the previous suite proved that a token was required, but
 * never that the credential endpoints behaved correctly: a wrong password, an
 * unknown email, an expired token, a token signed with the wrong secret, a
 * removed membership and an organization header the caller does not belong to
 * all have to answer a specific, non-disclosing status.
 */

type TokenBody = { token?: string; error?: string };
type SessionBody = {
  user: { id: string; email: string };
  organization: { id: string; name: string };
  role: string;
};

const PASSWORD = "correct horse battery";
const WRONG_PASSWORD = "tr0ubador&3";

let server: TestServer;
let orgA: string;
let orgB: string;
let ownerA: string;
let ownerB: string;

function decodeToken(token: string) {
  return jwt.decode(token) as {
    userId?: string;
    organizationId?: string | null;
    role?: string | null;
    exp?: number;
  } | null;
}

function register(
  email: string,
  organizationName = "Registered Org",
  password = PASSWORD
) {
  return apiRequest<TokenBody>(server.url, "POST", "/auth/register", {
    body: { email, password, organizationName },
  });
}

function login(email: string, password = PASSWORD) {
  return apiRequest<TokenBody>(server.url, "POST", "/auth/login", {
    body: { email, password },
  });
}

before(async () => {
  await setupTestDatabase();
  server = await startServer();
});

after(async () => {
  await server?.close();
  if (hasPool()) {
    await getPool().end();
  }
});

beforeEach(async () => {
  await resetDatabase();

  orgA = await createOrganization("Org A");
  orgB = await createOrganization("Org B");

  ownerA = await createUser("owner@a.example.test");
  ownerB = await createUser("owner@b.example.test");

  await addMembership(ownerA, orgA, "owner");
  await addMembership(ownerB, orgB, "owner");
});

describe("registration", () => {
  it("creates the account, its first organization and a usable owner session", async () => {
    const response = await register("new@example.test", "New Org");

    assert.equal(response.status, 201);
    assert.equal(typeof response.body.token, "string");

    const claims = decodeToken(response.body.token!);
    assert.ok(claims?.organizationId, "the token names an organization");
    assert.equal(claims?.role, "owner");

    const me = await apiRequest<SessionBody>(server.url, "GET", "/auth/me", {
      token: response.body.token!,
      organizationId: claims!.organizationId!,
    });

    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, "new@example.test");
    assert.equal(me.body.organization.name, "New Org");
    assert.equal(me.body.role, "owner");

    const session = await login("new@example.test");
    assert.equal(session.status, 200);

    const claimsAfterLogin = decodeToken(session.body.token!);
    assert.equal(claimsAfterLogin?.organizationId, claims?.organizationId);
    assert.equal(claimsAfterLogin?.userId, claims?.userId);
  });

  it("lower-cases the email so a mixed-case login finds the same account", async () => {
    const created = await register("Mixed.Case@Example.Test");
    assert.equal(created.status, 201);

    const response = await login("MIXED.CASE@example.test");

    assert.equal(response.status, 200);
    assert.equal(
      decodeToken(response.body.token!)?.userId,
      decodeToken(created.body.token!)?.userId
    );
  });

  it("rejects a short password, a malformed email and a missing organization name", async () => {
    const shortPassword = await apiRequest(server.url, "POST", "/auth/register", {
      body: { email: "short@example.test", password: "123456789", organizationName: "X" },
    });
    const badEmail = await apiRequest(server.url, "POST", "/auth/register", {
      body: { email: "not-an-email", password: PASSWORD, organizationName: "X" },
    });
    const noOrg = await apiRequest(server.url, "POST", "/auth/register", {
      body: { email: "noorg@example.test", password: PASSWORD, organizationName: "   " },
    });

    assert.equal(shortPassword.status, 400);
    assert.equal(badEmail.status, 400);
    assert.equal(noOrg.status, 400);
  });

  it("refuses a duplicate email and leaves no organization behind", async () => {
    const before = await getPool().query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM organizations"
    );

    await register("duplicate@example.test", "First Org");

    const duplicate = await register("duplicate@example.test", "Second Org");

    assert.equal(duplicate.status, 409);
    // Generic on purpose: the sentence a caller sees must not confirm that the
    // address already has an account. The precise reason is in the audit log.
    assert.equal(
      duplicate.body.error,
      "Registration could not be completed with these details."
    );
    assert.doesNotMatch(duplicate.body.error ?? "", /already exists|email exists/i);

    const after = await getPool().query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM organizations"
    );
    assert.equal(after.rows[0]!.count, String(Number(before.rows[0]!.count) + 1));
  });
});

describe("login", () => {
  it("answers 401 with one message for both wrong password and unknown email", async () => {
    const created = await register("known@example.test");
    assert.equal(created.status, 201);

    const wrongPassword = await login("known@example.test", WRONG_PASSWORD);
    const unknownEmail = await login("nobody@example.test", PASSWORD);

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.equal(wrongPassword.body.error, "Invalid email or password");
    // The same sentence in both branches is what stops the response body from
    // disclosing whether an account exists.
    assert.equal(unknownEmail.body.error, wrongPassword.body.error);
    assert.equal(wrongPassword.body.token, undefined);
    assert.equal(unknownEmail.body.token, undefined);
  });

  it("refuses a verified account with no organization membership", async () => {
    const hash = await bcrypt.hash(PASSWORD, 4);
    const result = await getPool().query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      ["orphan@example.test", hash]
    );
    assert.ok(result.rows[0]?.id);

    const response = await login("orphan@example.test");

    assert.equal(response.status, 409);
    assert.match(response.body.error ?? "", /not a member of any organization/i);
    assert.equal(response.body.token, undefined);

    const memberships = await getPool().query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM memberships WHERE user_id = $1",
      [result.rows[0]!.id]
    );
    assert.equal(memberships.rows[0]!.count, "0");
  });

  it("signs a multi-organization user into the oldest membership, deterministically", async () => {
    const hash = await bcrypt.hash(PASSWORD, 4);
    const userResult = await getPool().query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      ["multi@example.test", hash]
    );
    const userId = userResult.rows[0]!.id;

    // Inserted in the opposite order to the expected answer, with explicit
    // timestamps: this proves the choice is made by membership age rather than
    // by insertion order or by whatever the planner happened to return first.
    await getPool().query(
      `INSERT INTO memberships (user_id, organization_id, role, created_at)
       VALUES ($1, $2, 'admin', '2021-06-01T00:00:00Z')`,
      [userId, orgB]
    );
    await getPool().query(
      `INSERT INTO memberships (user_id, organization_id, role, created_at)
       VALUES ($1, $2, 'member', '2020-01-01T00:00:00Z')`,
      [userId, orgA]
    );

    const first = await login("multi@example.test");
    const second = await login("multi@example.test");

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    const firstClaims = decodeToken(first.body.token!);
    const secondClaims = decodeToken(second.body.token!);

    assert.equal(firstClaims?.organizationId, orgA);
    assert.equal(firstClaims?.role, "member");
    assert.equal(secondClaims?.organizationId, orgA);
    assert.equal(secondClaims?.role, "member");
  });
});

describe("token validation", () => {
  it("rejects a missing, malformed, wrongly signed or expired token with 401", async () => {
    const secret = process.env.JWT_SECRET!;

    const missing = await apiRequest(server.url, "GET", "/auth/me", {
      organizationId: orgA,
    });
    const malformed = await apiRequest(server.url, "GET", "/auth/me", {
      token: "not-a-jwt",
      organizationId: orgA,
    });
    const wrongSecret = await apiRequest(server.url, "GET", "/auth/me", {
      token: jwt.sign({ userId: ownerA }, "a-different-signing-secret-value", {
        algorithm: "HS256",
        expiresIn: "1h",
      }),
      organizationId: orgA,
    });
    const expired = await apiRequest(server.url, "GET", "/auth/me", {
      token: jwt.sign({ userId: ownerA }, secret, {
        algorithm: "HS256",
        expiresIn: -60,
      }),
      organizationId: orgA,
    });
    const noUserId = await apiRequest(server.url, "GET", "/auth/me", {
      token: jwt.sign({ sub: ownerA }, secret, {
        algorithm: "HS256",
        expiresIn: "1h",
      }),
      organizationId: orgA,
    });

    for (const response of [missing, malformed, wrongSecret, expired, noUserId]) {
      assert.equal(response.status, 401);
    }
  });

  it("rejects an unsigned token and one re-signed with a different HMAC size", async () => {
    const secret = process.env.JWT_SECRET!;

    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url"
    )}.${Buffer.from(JSON.stringify({ userId: ownerA })).toString("base64url")}.`;

    // Signed with the *correct* secret but a different algorithm: this is the
    // case an unpinned verifier accepts, so it is the one worth testing.
    const hs512 = jwt.sign({ userId: ownerA }, secret, {
      algorithm: "HS512",
      expiresIn: "1h",
    });

    const noneResponse = await apiRequest(server.url, "GET", "/auth/me", {
      token: unsigned,
      organizationId: orgA,
    });
    const hs512Response = await apiRequest(server.url, "GET", "/auth/me", {
      token: hs512,
      organizationId: orgA,
    });

    assert.equal(noneResponse.status, 401);
    assert.equal(hs512Response.status, 401);
  });

  it("rejects a missing, malformed or foreign organization header", async () => {
    const token = tokenFor(ownerA);

    const missing = await apiRequest(server.url, "GET", "/auth/me", { token });
    const notAUuid = await apiRequest(server.url, "GET", "/auth/me", {
      token,
      organizationId: "org-a",
    });
    const unknownOrg = await apiRequest(server.url, "GET", "/auth/me", {
      token,
      organizationId: "00000000-0000-4000-8000-000000000000",
    });
    const foreignOrg = await apiRequest(server.url, "GET", "/auth/me", {
      token,
      organizationId: orgB,
    });
    const ownOrg = await apiRequest(server.url, "GET", "/auth/me", {
      token,
      organizationId: orgA,
    });

    assert.equal(missing.status, 400);
    assert.equal(notAUuid.status, 400);
    assert.equal(unknownOrg.status, 403);
    assert.equal(foreignOrg.status, 403);
    assert.equal(ownOrg.status, 200);
  });

  it("stops honouring a token as soon as the membership is removed", async () => {
    const beforeRemoval = await apiRequest(server.url, "GET", "/auth/me", {
      token: tokenFor(ownerA),
      organizationId: orgA,
    });
    assert.equal(beforeRemoval.status, 200);

    await getPool().query(
      "DELETE FROM memberships WHERE user_id = $1 AND organization_id = $2",
      [ownerA, orgA]
    );

    const afterRemoval = await apiRequest(server.url, "GET", "/auth/me", {
      token: tokenFor(ownerA),
      organizationId: orgA,
    });

    // A JWT is a claim about identity, never an authorization decision: the
    // membership table is re-read on every request.
    assert.equal(afterRemoval.status, 403);
  });
});

describe("authentication boundary on every protected domain", () => {
  const protectedRoutes: Array<[string, string]> = [
    ["GET", "/auth/me"],
    ["GET", "/documents"],
    ["GET", `/documents/00000000-0000-4000-8000-000000000000`],
    ["POST", "/documents/00000000-0000-4000-8000-000000000000/reprocess"],
    ["DELETE", "/documents/00000000-0000-4000-8000-000000000000"],
    ["GET", "/logs"],
    ["POST", "/logs/ingest"],
    ["GET", "/tickets"],
    ["POST", "/tickets/ingest"],
    ["POST", "/ai/search"],
    ["POST", "/ai/ask"],
    ["GET", "/ingestion/jobs"],
    ["GET", "/ingestion/health"],
    ["POST", "/ingestion/reindex"],
    ["GET", "/insights/overview"],
    ["GET", "/insights/operations"],
    ["GET", "/insights/action-items"],
    ["GET", "/organization/members"],
    ["GET", "/admin/members"],
    ["GET", "/investigations"],
    ["POST", "/investigations"],
  ];

  it("answers 401 for every protected route without a token", async () => {
    const failures: string[] = [];

    for (const [method, path] of protectedRoutes) {
      const response = await apiRequest(server.url, method, path, {
        ...(method === "GET" ? {} : { body: {} }),
        organizationId: orgA,
      });

      if (response.status !== 401) {
        failures.push(`${method} ${path} -> ${response.status}`);
      }
    }

    assert.deepEqual(failures, []);
  });

  it("keeps the documented public endpoints public", async () => {
    const root = await apiRequest(server.url, "GET", "/");
    const health = await apiRequest(server.url, "GET", "/health");
    const ready = await apiRequest(server.url, "GET", "/ready");
    const status = await apiRequest(server.url, "GET", "/api/status");
    const aiHealth = await apiRequest<{
      healthy: boolean;
      generation: { provider: string; model: string };
    }>(server.url, "GET", "/ai/health");

    assert.equal(root.status, 200);
    assert.equal(health.status, 200);
    assert.equal(ready.status, 200);
    assert.equal(status.status, 200);
    // Reachable without a credential and carrying the full health payload; the
    // status is 200 or 503 depending on whether a provider answers, which is
    // exactly what the documented contract allows.
    assert.equal(typeof aiHealth.body.healthy, "boolean");
    assert.equal(typeof aiHealth.body.generation?.model, "string");
  });

  it("keeps development endpoints dark", async () => {
    const response = await apiRequest(server.url, "POST", "/ai/test-embedding", {
      token: tokenFor(ownerA),
      organizationId: orgA,
      body: { text: "hello" },
    });

    assert.equal(response.status, 404);
  });
});
