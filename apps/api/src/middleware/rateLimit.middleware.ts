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
  // Health checks must always answer, and they are cheap.
  skip: (req) => req.path === "/health",
  message: { error: "Too many requests. Please retry in a minute." },
});

/** Stricter budget for credential endpoints to slow password guessing. */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: positiveIntFromEnv("AUTH_RATE_LIMIT_MAX", 20),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many authentication attempts. Try again later." },
});
