import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  assertUsableJwtSecret,
  inspectJwtSecret,
  MIN_JWT_SECRET_LENGTH,
} from "./secrets.js";

const STRONG = "a".repeat(MIN_JWT_SECRET_LENGTH);
const originalWarn = console.warn;
const originalSecret = process.env.JWT_SECRET;
const originalNodeEnv = process.env.NODE_ENV;

function restore(): void {
  console.warn = originalWarn;

  if (originalSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = originalSecret;
  }

  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
}

describe("jwt secret policy", () => {
  beforeEach(() => {
    console.warn = (() => {}) as typeof console.warn;
  });

  afterEach(restore);

  it("accepts a long, non-placeholder secret", () => {
    assert.equal(inspectJwtSecret(STRONG).ok, true);
    assert.equal(inspectJwtSecret(`  ${STRONG}  `).ok, true);
  });

  it("rejects missing, short and placeholder secrets with a reason", () => {
    // The module loads .env, so the test environment has a real secret in it.
    delete process.env.JWT_SECRET;
    const missing = inspectJwtSecret();
    assert.equal(missing.ok, false);
    assert.match(missing.reason ?? "", /not set/);

    const short = inspectJwtSecret("secret-value");
    assert.equal(short.ok, false);
    assert.match(short.reason ?? "", /below the 32-character minimum/);

    // Still worthless even if someone padded it: it is the value this repo's
    // own compose file used to ship.
    const placeholder = inspectJwtSecret("change-me-in-production");
    assert.equal(placeholder.ok, false);
    assert.match(placeholder.reason ?? "", /placeholder/);
  });

  it("never puts the secret in the reason", () => {
    const reason = inspectJwtSecret("my-short-secret").reason ?? "";
    assert.equal(reason.includes("my-short-secret"), false);
  });

  it("refuses to start in production and only warns elsewhere", () => {
    process.env.JWT_SECRET = "too-short";

    process.env.NODE_ENV = "production";
    assert.throws(() => assertUsableJwtSecret(), /JWT_SECRET is unusable/);

    process.env.NODE_ENV = "development";
    assert.doesNotThrow(() => assertUsableJwtSecret());

    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = STRONG;
    assert.doesNotThrow(() => assertUsableJwtSecret());
  });
});
