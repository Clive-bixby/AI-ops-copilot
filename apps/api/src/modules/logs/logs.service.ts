import { pool } from "../../core/db.js";
import { LogParseError, parseRawLogs } from "./log.parser.js";

type StoredLogRow = {
  id: string;
  organization_id: string;
  level: string;
  message: string;
  metadata: Record<string, unknown> | null;
  timestamp: string;
  created_at: string;
};

export class LogsValidationError extends Error {}
export { LogParseError };

export async function ingestLogs(organizationId: string, payload: unknown) {
  const orgId = (organizationId || "").trim();
  if (!orgId) {
    throw new LogsValidationError("Organization ID is required");
  }

  const normalizedLogs = parseRawLogs(payload);

  // One multi-row INSERT for the whole batch instead of a statement per row:
  // a 1000-entry payload used to mean 1000 round trips inside a transaction.
  const values: unknown[] = [];
  const placeholders: string[] = [];

  normalizedLogs.forEach((log, index) => {
    const base = index * 5;
    values.push(orgId, log.level, log.message, log.metadata, log.timestamp);
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`
    );
  });

  const result = await pool.query<StoredLogRow>(
    `
    INSERT INTO logs (organization_id, level, message, metadata, timestamp)
    VALUES ${placeholders.join(", ")}
    RETURNING id, organization_id, level, message, metadata, timestamp, created_at
    `,
    values
  );

  // Postgres returns RETURNING rows in insertion order for a single statement,
  // so the response keeps the order of the submitted logs.
  return result.rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    level: row.level,
    message: row.message,
    metadata: row.metadata || {},
    timestamp: row.timestamp,
    createdAt: row.created_at,
  }));
}

export async function listLogs(organizationId: string) {
  const result = await pool.query<StoredLogRow>(
    `SELECT id, organization_id, level, message, metadata, timestamp, created_at
     FROM logs
     WHERE organization_id = $1
     ORDER BY timestamp DESC
     LIMIT 100`,
    [organizationId]
  );
  return result.rows;
}
