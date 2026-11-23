import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isUuid } from "./uuid.js";

describe("isUuid", () => {
  it("accepts a canonical uuid in either case", () => {
    assert.equal(isUuid("3f0c8a52-5b3e-4a2f-9a1c-7d2b1e4c6f80"), true);
    assert.equal(isUuid("3F0C8A52-5B3E-4A2F-9A1C-7D2B1E4C6F80"), true);
    assert.equal(isUuid("  3f0c8a52-5b3e-4a2f-9a1c-7d2b1e4c6f80  "), true);
  });

  it("rejects what Postgres would raise a cast error for", () => {
    assert.equal(isUuid("abc"), false);
    assert.equal(isUuid(""), false);
    assert.equal(isUuid(undefined), false);
    assert.equal(isUuid(null), false);
    // The SQL injection shape: it is a parameter, but it still is not an id.
    assert.equal(isUuid("' OR 1=1 --"), false);
  });
});
