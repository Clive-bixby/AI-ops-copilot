import { createHttpError } from "./httpError.js";

/**
 * Page size for the plain list endpoints (`/documents`, `/logs`, `/tickets`).
 *
 * 200 is chosen so the existing UI does not change: `/logs` and `/tickets` were
 * already capped at 100 in SQL, and a tenant's document vault is far below 200,
 * so every list the SPA renders today still renders whole. What changes is the
 * worst case — a tenant that grows past the cap now gets a bounded response it
 * can page through instead of an unbounded one.
 *
 * The response shape is unchanged (an array), so a client that sends no
 * parameters keeps working without modification.
 */
export const DEFAULT_LIST_LIMIT = 200;

/** Hard ceiling for a single page. A larger `limit` is a 400, not a clamp. */
export const MAX_LIST_LIMIT = 500;

/**
 * Offset ceiling. Deep offsets are a scan, and this is a recent-items list, not
 * an export API; a client asking to skip more than this is misusing it.
 */
export const MAX_LIST_OFFSET = 100_000;

export type ListPagination = {
  limit: number;
  offset: number;
};

function readSingle(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined;
  }

  return typeof value === "string" ? value : undefined;
}

function readInteger(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
  fallback: number
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);

  // `Number("")` is 0 and `Number(" 5 ")` is 5, but "5abc" and "1.5" are not
  // integers, so each is rejected explicitly instead of being coerced.
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw createHttpError(
      400,
      `${name} must be an integer between ${min} and ${max}`
    );
  }

  return parsed;
}

/**
 * Parse `limit` / `offset` from a request query.
 *
 * Invalid values are refused with 400 rather than silently replaced by the
 * default: a client that asked for `limit=0` or `offset=-1` has a bug, and
 * answering with a full page hides it.
 */
export function readListPagination(query: unknown): ListPagination {
  const record = (query ?? {}) as Record<string, unknown>;

  return {
    limit: readInteger(
      readSingle(record.limit),
      "limit",
      1,
      MAX_LIST_LIMIT,
      DEFAULT_LIST_LIMIT
    ),
    offset: readInteger(
      readSingle(record.offset),
      "offset",
      0,
      MAX_LIST_OFFSET,
      0
    ),
  };
}
