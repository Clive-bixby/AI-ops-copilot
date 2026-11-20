import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LogParseError, parseRawLogs } from "./log.parser.js";

describe("parseRawLogs", () => {
  it("accepts a bare string as an info log", () => {
    const [log] = parseRawLogs("disk usage high");

    assert.ok(log);
    assert.equal(log.level, "info");
    assert.equal(log.message, "disk usage high");
    assert.deepEqual(log.metadata, {});
  });

  it("normalises level casing and synonyms", () => {
    const logs = parseRawLogs([
      { message: "a", level: " ERROR " },
      { message: "b", severity: "Warn" },
      { message: "c", logLevel: "debug" },
    ]);

    assert.deepEqual(
      logs.map((log) => log.level),
      ["error", "warn", "debug"]
    );
  });

  it("falls back to info for unknown or non-string levels", () => {
    const logs = parseRawLogs([
      { message: "a", level: "trace" },
      { message: "b", level: 42 },
      { message: "c" },
    ]);

    assert.deepEqual(
      logs.map((log) => log.level),
      ["info", "info", "info"]
    );
  });

  it("builds a message from leftover keys when none is given", () => {
    const [log] = parseRawLogs({ service: "api", code: 503 });

    assert.ok(log);
    assert.equal(log.message, "service=api code=503");
    assert.deepEqual(log.metadata, { service: "api", code: 503 });
  });

  it("rejects an object that carries no usable content", () => {
    assert.throws(() => parseRawLogs({ level: "info" }), LogParseError);
  });

  it("replaces an unparseable timestamp with a valid ISO string", () => {
    const [log] = parseRawLogs({ message: "a", timestamp: "not a date" });

    assert.ok(log);
    assert.ok(!Number.isNaN(Date.parse(log.timestamp)));
    assert.equal(new Date(log.timestamp).toISOString(), log.timestamp);
  });

  it("keeps a valid timestamp in ISO form", () => {
    const [log] = parseRawLogs({
      message: "a",
      timestamp: "2024-01-02T03:04:05Z",
    });

    assert.ok(log);
    assert.equal(log.timestamp, "2024-01-02T03:04:05.000Z");
  });

  it("drops blank strings from a batch but keeps real entries", () => {
    const logs = parseRawLogs(["first", "   ", { message: "second" }]);

    assert.deepEqual(
      logs.map((log) => log.message),
      ["first", "second"]
    );
  });

  it("rejects empty batches and non-string, non-object entries", () => {
    assert.throws(() => parseRawLogs([]), LogParseError);
    assert.throws(() => parseRawLogs({ logs: [] }), LogParseError);
    assert.throws(() => parseRawLogs([42]), LogParseError);
  });
});
