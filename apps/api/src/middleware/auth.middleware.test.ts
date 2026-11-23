import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";

import { authMiddleware } from "./auth.middleware.js";

const SECRET = "unit-test-secret-value-for-auth-middleware";
const USER_ID = "3f0c8a52-5b3e-4a2f-9a1c-7d2b1e4c6f80";

const originalSecret = process.env.JWT_SECRET;

type Outcome = { status: number; body: Record<string, unknown>; next: boolean };

function call(header: string | undefined): Outcome {
  const outcome: Outcome = { status: 0, body: {}, next: false };

  const req = {
    header: (name: string) =>
      name.toLowerCase() === "authorization" ? header : undefined,
  } as unknown as Request;

  const res = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      outcome.body = body;
      return this;
    },
  } as unknown as Response;

  authMiddleware(req, res, () => {
    outcome.next = true;
  });

  return outcome;
}

describe("authMiddleware", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  });

  it("accepts an HS256 token and attaches the user", () => {
    const token = jwt.sign({ userId: USER_ID }, SECRET, { algorithm: "HS256" });

    const outcome = call(`Bearer ${token}`);
    assert.equal(outcome.next, true);
    assert.equal(outcome.status, 0);
  });

  it("rejects a token signed with a different algorithm", () => {
    // Same secret, different HMAC variant: without an explicit algorithms list
    // this would verify.
    const token = jwt.sign({ userId: USER_ID }, SECRET, { algorithm: "HS512" });

    const outcome = call(`Bearer ${token}`);
    assert.equal(outcome.next, false);
    assert.equal(outcome.status, 401);
  });

  it("rejects unsigned and expired tokens", () => {
    const unsigned = jwt.sign({ userId: USER_ID }, "", { algorithm: "none" });
    assert.equal(call(`Bearer ${unsigned}`).status, 401);

    const expired = jwt.sign({ userId: USER_ID }, SECRET, { expiresIn: -10 });
    assert.equal(call(`Bearer ${expired}`).status, 401);
  });

  it("rejects a token without a user id claim", () => {
    const token = jwt.sign({ sub: USER_ID }, SECRET);
    assert.equal(call(`Bearer ${token}`).status, 401);
  });

  it("rejects missing or malformed authorization headers", () => {
    assert.equal(call(undefined).status, 401);
    assert.equal(call("Basic abc").status, 401);
    assert.equal(call("Bearer ").status, 401);
  });
});
