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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const storedLogs: Array<{
      id: string;
      organizationId: string;
      level: string;
      message: string;
      metadata: Record<string, unknown>;
      timestamp: string;
      createdAt: string;
    }> = [];

    for (const log of normalizedLogs) {
      const result = await client.query<StoredLogRow>(
        `
        INSERT INTO logs (organization_id, level, message, metadata, timestamp)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, organization_id, level, message, metadata, timestamp, created_at
        `,
        [orgId, log.level, log.message, log.metadata, log.timestamp]
      );

      const storedLog = result.rows[0];
      if (!storedLog) {
        throw new Error("Failed to store log");
      }

      storedLogs.push({
        id: storedLog.id,
        organizationId: storedLog.organization_id,
        level: storedLog.level,
        message: storedLog.message,
        metadata: storedLog.metadata || {},
        timestamp: storedLog.timestamp,
        createdAt: storedLog.created_at,
      });
    }

    await client.query("COMMIT");
    return storedLogs;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures and throw original error below.
    }
    throw error;
  } finally {
    client.release();
  }
}
