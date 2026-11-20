import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { logger } from "./logger.js";

const captured: { level: string; text: string }[] = [];

const original = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

function stubConsole(): void {
  console.log = ((...args: unknown[]) => {
    captured.push({ level: "info", text: String(args[0]) });
  }) as typeof console.log;
  console.warn = ((...args: unknown[]) => {
    captured.push({ level: "warn", text: String(args[0]) });
  }) as typeof console.warn;
  console.error = ((...args: unknown[]) => {
    captured.push({ level: "error", text: String(args[0]) });
  }) as typeof console.error;
}

function restore(): void {
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
}

describe("logger", () => {
  afterEach(() => {
    captured.length = 0;
    restore();
  });

  it("writes exactly one parseable JSON object per call", () => {
    stubConsole();
    logger.info("request.completed", { requestId: "abc", status: 200 });

    assert.equal(captured.length, 1);
    const line = captured[0];
    assert.ok(line);
    const parsed = JSON.parse(line.text) as Record<string, unknown>;

    assert.equal(parsed.level, "info");
    assert.equal(parsed.message, "request.completed");
    assert.equal(parsed.requestId, "abc");
    assert.equal(parsed.status, 200);
    assert.equal(typeof parsed.time, "string");
    assert.match(String(parsed.time), /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
  });

  it("serialises Error fields that JSON.stringify would drop", () => {
    stubConsole();
    const error = new TypeError("database exploded");
    logger.error("health.database_probe_failed", { error });

    const line = captured[0];
    assert.ok(line);
    const parsed = JSON.parse(line.text) as {
      error: { name: string; message: string; stack?: string };
    };

    assert.equal(parsed.error.name, "TypeError");
    assert.equal(parsed.error.message, "database exploded");
    assert.match(parsed.error.stack ?? "", /TypeError: database exploded/);
  });

  it("sends warnings and errors to the matching console stream", () => {
    stubConsole();
    logger.warn("request.rejected", { status: 401 });
    logger.error("request.failed", { status: 500 });

    assert.deepEqual(
      captured.map((entry) => entry.level),
      ["warn", "error"]
    );
  });
});
