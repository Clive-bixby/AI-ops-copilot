import type { PoolClient } from "pg";

import { pool } from "../../core/db.js";
import type {
  InvestigationActivity,
  InvestigationActivityType,
} from "./types.js";

type ActivityRow = {
  id: string;
  type: string;
  actor_user_id: string | null;
  actor_email: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
};

function toIso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapActivity(row: ActivityRow): InvestigationActivity {
  return {
    id: row.id,
    type: row.type as InvestigationActivityType,
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    body: row.body,
    metadata: row.metadata,
    createdAt: toIso(row.created_at) ?? "",
  };
}

/**
 * Append one activity row. The INSERT is wrapped in a CTE so the actor's email
 * comes back in the same statement instead of a second round trip.
 *
 * Called from inside the caller's transaction: an activity row that survives a
 * rolled-back metadata update would describe something that never happened.
 */
export async function insertActivity(
  client: PoolClient,
  input: {
    investigationId: string;
    organizationId: string;
    type: InvestigationActivityType;
    actorUserId: string | null;
    body: string | null;
    metadata: Record<string, unknown> | null;
  }
): Promise<InvestigationActivity> {
  const result = await client.query<ActivityRow>(
    `WITH inserted AS (
       INSERT INTO investigation_activity (
         investigation_id, organization_id, type, actor_user_id, body, metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, type, actor_user_id, body, metadata, created_at
     )
     SELECT i.id, i.type, i.actor_user_id, u.email AS actor_email, i.body, i.metadata, i.created_at
     FROM inserted i
     LEFT JOIN users u ON u.id = i.actor_user_id`,
    [
      input.investigationId,
      input.organizationId,
      input.type,
      input.actorUserId,
      input.body,
      input.metadata === null ? null : JSON.stringify(input.metadata),
    ]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Failed to record investigation activity");
  }

  return mapActivity(row);
}

export async function listActivity(
  organizationId: string,
  investigationId: string,
  limit = 100
): Promise<InvestigationActivity[]> {
  const result = await pool.query<ActivityRow>(
    `SELECT
       a.id,
       a.type,
       a.actor_user_id,
       u.email AS actor_email,
       a.body,
       a.metadata,
       a.created_at
     FROM investigation_activity a
     LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.investigation_id = $1 AND a.organization_id = $2
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $3`,
    [investigationId, organizationId, limit]
  );

  return result.rows.map(mapActivity);
}
