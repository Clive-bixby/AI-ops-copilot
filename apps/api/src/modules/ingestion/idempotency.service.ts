import { pool } from "../../core/db.js";
import { logger } from "../../core/logger.js";

export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export type IdempotentResponse = {
  status: number;
  body: unknown;
};

export class IdempotencyKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyKeyError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

type StoredRow = {
  id: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  completed_at: string | null;
};

/**
 * Execute a mutating request at most once per Idempotency-Key.
 *
 * The key row is inserted before the handler runs, so two concurrent requests
 * with the same key cannot both do the work: the second sees the unfinished row
 * and is told the request is still in progress. A handler failure deletes the
 * row, which lets the client retry with the same key instead of being stuck on
 * an error that was never stored.
 *
 * `requestHash` is compared on replay: reusing a key for a different payload is
 * a client bug, not something to answer with the previous response.
 */
export async function runIdempotent(input: {
  organizationId: string;
  endpoint: string;
  key: string | undefined;
  requestHash: string;
  handler: () => Promise<IdempotentResponse>;
}): Promise<IdempotentResponse & { replayed: boolean }> {
  const key = input.key?.trim();

  if (!key) {
    const response = await input.handler();
    return { ...response, replayed: false };
  }

  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new IdempotencyKeyError(
      `Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`
    );
  }

  const inserted = await pool.query<{ id: string }>(
    `
    INSERT INTO ingest_idempotency (
      organization_id, endpoint, idempotency_key, request_hash
    )
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (organization_id, endpoint, idempotency_key) DO NOTHING
    RETURNING id
    `,
    [input.organizationId, input.endpoint, key, input.requestHash]
  );

  const id = inserted.rows[0]?.id;

  if (!id) {
    const existing = await pool.query<StoredRow>(
      `
      SELECT id, request_hash, response_status, response_body, completed_at
      FROM ingest_idempotency
      WHERE organization_id = $1 AND endpoint = $2 AND idempotency_key = $3
      `,
      [input.organizationId, input.endpoint, key]
    );

    const row = existing.rows[0];
    if (!row) {
      throw new Error("Failed to read idempotency record");
    }

    if (row.request_hash !== input.requestHash) {
      throw new IdempotencyConflictError(
        "Idempotency-Key was already used for a different request"
      );
    }

    if (row.completed_at && row.response_status !== null) {
      logger.info("idempotency.replayed", {
        organizationId: input.organizationId,
        endpoint: input.endpoint,
        status: row.response_status,
      });

      return {
        status: row.response_status,
        body: row.response_body,
        replayed: true,
      };
    }

    throw new IdempotencyConflictError(
      "A request with this Idempotency-Key is still in progress"
    );
  }

  try {
    const response = await input.handler();

    // A server-side failure is retryable: caching it under the key would make
    // every retry return the same error even after the cause is fixed.
    if (response.status >= 500) {
      await pool.query(`DELETE FROM ingest_idempotency WHERE id = $1`, [id]);
      return { ...response, replayed: false };
    }

    await pool.query(
      `
      UPDATE ingest_idempotency
      SET response_status = $2,
          response_body = $3::jsonb,
          completed_at = NOW()
      WHERE id = $1
      `,
      [id, response.status, JSON.stringify(response.body)]
    );

    return { ...response, replayed: false };
  } catch (error) {
    // The request did not produce a response worth replaying. Remove the key so
    // the client can retry instead of receiving a permanent 409.
    try {
      await pool.query(`DELETE FROM ingest_idempotency WHERE id = $1`, [id]);
    } catch (deleteError) {
      logger.error("idempotency.release_failed", {
        organizationId: input.organizationId,
        endpoint: input.endpoint,
        error: deleteError,
      });
    }

    throw error;
  }
}
