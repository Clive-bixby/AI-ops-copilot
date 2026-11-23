// This module reads the environment at import time, so it loads the file itself
// rather than relying on an earlier import having done it.
import "./env.js";

/**
 * Security-related configuration resolved once at startup so the values can be
 * logged and asserted instead of being read ad hoc at request time.
 */

const DEFAULT_DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  // Vite falls back to the next free port when 5173 is taken by another project.
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:5175",
  "http://127.0.0.1:5175",
  "http://localhost:5176",
  "http://127.0.0.1:5176",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

/**
 * Origins allowed to call the API from a browser.
 *
 * A wildcard was previously accepted, which let any site drive the API with a
 * user's token. Production requires an explicit CORS_ORIGINS list: an empty
 * list means no cross-origin browser access at all, which is the safe default.
 */
export function resolveAllowedOrigins(): string[] {
  const configured = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured.length > 0) {
    return configured;
  }

  return process.env.NODE_ENV === "production" ? [] : DEFAULT_DEV_ORIGINS;
}

/** Largest JSON request body accepted, e.g. a batch of ingested logs. */
export const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT?.trim() || "1mb";

/**
 * Express `trust proxy` value, parsed from the environment.
 *
 * The raw variable is a string, and Express treats a string as an address list,
 * not as a hop count: `TRUST_PROXY=1` trusted nothing, so `req.ip` stayed the
 * proxy's address, `req.protocol` stayed "http", and every client shared one
 * rate-limit bucket. A bare integer has to become a number to mean "the last N
 * proxies are trusted".
 *
 * `true` is refused on purpose: it trusts an `X-Forwarded-For` header from anyone,
 * which lets a client forge its own address and walk past the rate limiter.
 */
export function resolveTrustProxy(): number | string[] | false {
  const raw = (process.env.TRUST_PROXY ?? "").trim();

  if (!raw) {
    return false;
  }

  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);

    if (hops === 0) {
      return false;
    }

    if (hops > 10) {
      console.warn(
        `TRUST_PROXY=${raw} trusts ${hops} hops; that is almost certainly a mistake. Using 1.`
      );
      return 1;
    }

    return hops;
  }

  if (raw.toLowerCase() === "true") {
    console.warn(
      "TRUST_PROXY=true trusts any X-Forwarded-For header, so clients could spoof their address and bypass rate limits. Ignoring it; set a hop count (e.g. 1) or an address list instead."
    );
    return false;
  }

  if (raw.toLowerCase() === "false") {
    return false;
  }

  // An explicit list of proxy addresses or CIDR ranges, e.g. "10.0.0.0/8,172.16.0.0/12".
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    return false;
  }

  return entries;
}

/** Test-only /ai/test-* routes stay dark unless this is explicitly enabled. */
export const ENABLE_DEV_ENDPOINTS =
  process.env.ENABLE_DEV_ENDPOINTS?.trim().toLowerCase() === "true";
