import "../config/env.js";

import rateLimit from "express-rate-limit";

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`Invalid ${name}; using default`, { value: raw, fallback });
    return fallback;
  }

  return Math.floor(parsed);
}

/** Broad per-IP budget for the whole API. */
export const apiRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: positiveIntFromEnv("RATE_LIMIT_MAX", 120),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Probes must always answer, and they are cheap.
  skip: (req) => req.path === "/health" || req.path === "/ready",
  message: { error: "Too many requests. Please retry in a minute." },
});

/**
 * Budget for the routes that spend provider quota.
 *
 * Generation and query embedding are the only calls that cost money per
 * request, so they do not share the broad per-IP API budget: one authenticated
 * member looping `/ai/ask` or `/investigations/:id/analyze` could otherwise
 * exhaust the owner's quota within the ordinary 120/min allowance. Mounted on
 * the routes that call a model, never on reads.
 */
export const aiRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: positiveIntFromEnv("AI_RATE_LIMIT_MAX", 20),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many AI requests. Please retry in a minute." },
});

/** Stricter budget for credential endpoints to slow password guessing. */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: positiveIntFromEnv("AUTH_RATE_LIMIT_MAX", 20),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many authentication attempts. Try again later." },
});
