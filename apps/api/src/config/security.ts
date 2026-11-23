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

/** Test-only /ai/test-* routes stay dark unless this is explicitly enabled. */
export const ENABLE_DEV_ENDPOINTS =
  process.env.ENABLE_DEV_ENDPOINTS?.trim().toLowerCase() === "true";
