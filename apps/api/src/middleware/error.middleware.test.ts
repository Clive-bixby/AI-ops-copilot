import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Request, Response } from "express";

import { errorMiddleware } from "./error.middleware.js";
import { AuthUnauthorizedError, AuthValidationError } from "../modules/auth/auth.service.js";
import { LogParseError } from "../modules/logs/log.parser.js";
import { RAGProviderTimeoutError } from "../modules/ai/rag.service.js";
import { EmbeddingModelError } from "../modules/ai/embedding.service.js";
import {
  InvestigationConflictError,
  InvestigationNotFoundError,
  InvestigationValidationError,
} from "../modules/investigations/errors.js";

type Captured = { status: number; body: Record<string, unknown> };

const originalError = console.error;

function handle(error: unknown, requestId?: string): Captured {
  const captured: Captured = { status: 0, body: {} };
  const req = {
    id: requestId,
    method: "GET",
    originalUrl: "/thing",
  } as unknown as Request;
  const res = {
    status(code: number) {
      captured.status = code;
      captured.body.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;

  errorMiddleware(error as Error, req, res, () => {});
  return captured;
}

describe("errorMiddleware", () => {
  beforeEach(() => {
    // The handler logs every error; keep the test output readable.
    console.error = (() => {}) as typeof console.error;
  });

  afterEach(() => {
    console.error = originalError;
  });

  it("maps known error classes to their status, not 500", () => {
    assert.equal(handle(new AuthUnauthorizedError("bad password")).status, 401);
    assert.equal(handle(new AuthValidationError("email required")).status, 400);
    assert.equal(handle(new LogParseError("no message")).status, 400);
    assert.equal(handle(new RAGProviderTimeoutError("slow")).status, 504);
  });

  it("maps investigation errors to validation, not-found and conflict", () => {
    assert.equal(handle(new InvestigationValidationError("bad title")).status, 400);
    assert.equal(handle(new InvestigationNotFoundError()).status, 404);
    assert.equal(handle(new InvestigationConflictError("closed")).status, 409);
    // A not-found must keep its message: it is the only answer a cross-tenant
    // probe is allowed to receive.
    assert.equal(
      handle(new InvestigationNotFoundError()).body.error,
      "Investigation not found"
    );
  });

  it("keeps the message for 4xx and hides internals for 5xx", () => {
    const client = handle(new LogParseError("Log message is required"));
    assert.equal(client.body.error, "Log message is required");

    const server = handle(new Error("relation \"users\" does not exist"));
    assert.equal(server.status, 500);
    assert.equal(server.body.error, "Internal server error");
  });

  it("keeps the message of a configuration 5xx", () => {
    // A fixture deployment refuses unrecorded text. The status says "this
    // service cannot do that"; the message is the only thing that tells a demo
    // visitor which provider actually runs here.
    const capped = handle(
      new EmbeddingModelError("This deployment replays recorded embeddings.")
    );

    assert.equal(capped.status, 503);
    assert.equal(capped.body.error, "This deployment replays recorded embeddings.");

    // Anything else above 500 still hides its internals.
    const other = handle(
      new (class extends Error {
        readonly statusCode = 503;
      })("connect ECONNREFUSED 10.0.0.4:5432")
    );
    assert.equal(other.body.error, "Internal server error");
  });

  it("honours an explicit statusCode on the error", () => {
    const error = Object.assign(new Error("Too many requests"), {
      statusCode: 429,
    });

    assert.equal(handle(error).status, 429);
  });

  it("includes the request id so a reported failure can be found", () => {
    assert.equal(handle(new Error("boom"), "trace-123").body.requestId, "trace-123");
    assert.equal("requestId" in handle(new Error("boom")).body, false);
  });
});
