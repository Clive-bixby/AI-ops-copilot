import "./env.js";

import { logger } from "../core/logger.js";

/**
 * A 256-bit secret is the floor for an HMAC signing key. Anything shorter is
 * within reach of an offline guess, and a guessed key mints a token for any user.
 */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Values people copy from an example file. They are public knowledge, so a
 * deployment using one has no authentication at all — worse than a wrong secret,
 * because everything appears to work.
 */
const PLACEHOLDER_SECRETS = new Set([
  "change-me-in-production",
  "change-me",
  "changeme",
  "secret",
  "jwt-secret",
  "jwtsecret",
  "your-secret",
  "your-secret-key",
  "supersecret",
  "test-secret",
  "development-secret",
]);

export type JwtSecretInspection = {
  ok: boolean;
  /** Why it is unusable. Never contains the secret itself. */
  reason?: string;
};

export function inspectJwtSecret(
  secret: string | undefined = process.env.JWT_SECRET
): JwtSecretInspection {
  const value = (secret ?? "").trim();

  if (!value) {
    return { ok: false, reason: "it is not set" };
  }

  if (PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
    return { ok: false, reason: "it is a well-known placeholder value" };
  }

  if (value.length < MIN_JWT_SECRET_LENGTH) {
    return {
      ok: false,
      reason: `it is ${value.length} characters, below the ${MIN_JWT_SECRET_LENGTH}-character minimum`,
    };
  }

  return { ok: true };
}

export const JWT_SECRET_HINT =
  "Generate one with: openssl rand -hex 32";

/**
 * Refuse to start in production with a secret that cannot protect tokens.
 *
 * Outside production this is a warning: a developer running the API locally with
 * a short secret should hear about it, not be blocked from starting. Logging the
 * reason (and never the value) keeps it actionable.
 */
export function assertUsableJwtSecret(): void {
  const inspection = inspectJwtSecret();

  if (inspection.ok) {
    return;
  }

  if (process.env.NODE_ENV !== "production") {
    logger.warn("config.jwt_secret_weak", {
      reason: inspection.reason,
      detail: "Accepted outside production; a production deployment refuses it.",
    });
    return;
  }

  throw new Error(
    `JWT_SECRET is unusable: ${inspection.reason}. ${JWT_SECRET_HINT}`
  );
}
