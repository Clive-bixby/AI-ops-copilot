import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resolveTrustProxy } from "./security.js";

const originalTrustProxy = process.env.TRUST_PROXY;
const originalWarn = console.warn;

function setTrustProxy(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.TRUST_PROXY;
    return;
  }

  process.env.TRUST_PROXY = value;
}

describe("resolveTrustProxy", () => {
  beforeEach(() => {
    console.warn = (() => {}) as typeof console.warn;
  });

  afterEach(() => {
    console.warn = originalWarn;

    if (originalTrustProxy === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = originalTrustProxy;
    }
  });

  it("treats a bare integer as a hop count, not an address list", () => {
    // This is the regression: Express reads a string as an address list, so "1"
    // trusted nothing and every client shared one rate-limit bucket.
    setTrustProxy("1");
    assert.equal(resolveTrustProxy(), 1);

    setTrustProxy("2");
    assert.equal(resolveTrustProxy(), 2);
  });

  it("treats absent and zero as trusting nothing", () => {
    setTrustProxy(undefined);
    assert.equal(resolveTrustProxy(), false);

    setTrustProxy("");
    assert.equal(resolveTrustProxy(), false);

    setTrustProxy("0");
    assert.equal(resolveTrustProxy(), false);

    setTrustProxy("false");
    assert.equal(resolveTrustProxy(), false);
  });

  it("refuses true, which would let clients spoof their address", () => {
    setTrustProxy("true");
    assert.equal(resolveTrustProxy(), false);
  });

  it("passes an explicit address list through", () => {
    setTrustProxy("10.0.0.0/8, 172.16.0.0/12");
    assert.deepEqual(resolveTrustProxy(), ["10.0.0.0/8", "172.16.0.0/12"]);
  });

  it("clamps an implausible hop count", () => {
    setTrustProxy("99");
    assert.equal(resolveTrustProxy(), 1);
  });
});
