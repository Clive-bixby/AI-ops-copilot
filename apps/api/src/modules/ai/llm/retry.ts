/**
 * Retry policy shared by both generation providers.
 *
 * Only a throttled or temporarily failing provider is retried. A rejected
 * credential, an unknown model or a malformed request is not: repeating it
 * spends quota to get the same answer, and hides the real cause from the
 * engineer.
 */

/** A failure worth another attempt, carrying the provider's own hint if any. */
export class RetryableFailure extends Error {
  /** HTTP status, or null when the attempt timed out at the HTTP layer. */
  readonly status: number | null;
  /** Delay the provider asked for (Retry-After), in milliseconds. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    status: number | null = null,
    retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "RetryableFailure";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A timeout is worth retrying, but it is still a timeout when the budget runs
 * out: the endpoint contract answers 504, not 502. This subclass keeps the two
 * decisions separate instead of collapsing them into one status.
 */
export class RetryableTimeout extends RetryableFailure {
  constructor(message: string) {
    super(message);
    this.name = "RetryableTimeout";
  }
}

const MAX_RETRY_AFTER_MS = 30_000;
const MAX_BACKOFF_MS = 8_000;

/**
 * `Retry-After` is either a number of seconds or an HTTP date. Both forms are
 * capped: a provider that asks for an hour must not hold a request open, and the
 * caller has a 60 s budget anyway.
 */
export function parseRetryAfter(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  }

  const at = Date.parse(value);
  if (!Number.isNaN(at)) {
    return Math.max(0, Math.min(at - Date.now(), MAX_RETRY_AFTER_MS));
  }

  return null;
}

/** Exponential backoff with full jitter, so parallel retries do not synchronise. */
export function backoffMs(attempt: number, baseDelayMs: number): number {
  const exponential = Math.min(
    baseDelayMs * 2 ** Math.max(0, attempt - 1),
    MAX_BACKOFF_MS
  );

  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}

export function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `run` until it succeeds or the retry budget is gone. A `RetryableFailure`
 * that outlives the budget is rethrown as-is so the provider can turn it into a
 * final `LlmProviderError` with the right status; anything else propagates at
 * once.
 */
export async function runWithRetries<T>(input: {
  maxRetries: number;
  baseDelayMs: number;
  run: () => Promise<T>;
}): Promise<{ value: T; attempts: number }> {
  const maxRetries = Math.max(0, input.maxRetries);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return { value: await input.run(), attempts: attempt };
    } catch (error) {
      if (!(error instanceof RetryableFailure) || attempt > maxRetries) {
        throw error;
      }

      await sleep(
        error.retryAfterMs ?? backoffMs(attempt, Math.max(1, input.baseDelayMs))
      );
    }
  }
}
