import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveRequestId } from "./requestLog.middleware.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("resolveRequestId", () => {
  it("keeps a caller id that is safe to log", () => {
    assert.equal(
      resolveRequestId("trace-01H8XYZ.abc:def"),
      "trace-01H8XYZ.abc:def"
    );
    assert.equal(resolveRequestId("abcdefgh"), "abcdefgh");
  });

  it("replaces a missing, short or unsafe caller id", () => {
    assert.match(resolveRequestId(undefined), UUID_V4);
    assert.match(resolveRequestId("short"), UUID_V4);
    assert.match(resolveRequestId("bad id with spaces"), UUID_V4);
    assert.match(resolveRequestId("inject\nnot-a-new-line"), UUID_V4);
    assert.match(resolveRequestId("x".repeat(129)), UUID_V4);
  });
});
