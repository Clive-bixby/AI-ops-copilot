import { pool } from "../../core/db.js";

export type OverviewResponse = {
  documents: {
    total: number;
    processed: number;
    processing: number;
    pending: number;
    failed: number;
    chunks: number;
    lastIngestedAt: string | null;
  };
  logs: {
    total: number;
    errors: number;
    warnings: number;
    lastSeenAt: string | null;
    byLevel: Record<string, number>;
  };
  tickets: {
    total: number;
    open: number;
    urgentOpen: number;
    lastCreatedAt: string | null;
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
  };
};

type CountRow = { key: string; count: number };

function toCountMap(rows: CountRow[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.key] = Number(row.count);
    return acc;
  }, {});
}

export async function getOverview(organizationId: string): Promise<OverviewResponse> {
  const [
    documentsResult,
    chunksResult,
    logsResult,
    logLevelsResult,
    ticketsResult,
    ticketStatusResult,
    ticketPriorityResult,
  ] = await Promise.all([
    pool.query<{
      total: number;
      processed: number;
      processing: number;
      pending: number;
      failed: number;
      last_ingested_at: string | null;
    }>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE processing_status = 'processed')::int AS processed,
         COUNT(*) FILTER (WHERE processing_status = 'processing')::int AS processing,
         COUNT(*) FILTER (WHERE processing_status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE processing_status = 'failed')::int AS failed,
         MAX(created_at) AS last_ingested_at
       FROM documents
       WHERE organization_id = $1`,
      [organizationId]
    ),
    pool.query<{ chunks: number }>(
      `SELECT COUNT(*)::int AS chunks
       FROM source_chunks
       WHERE organization_id = $1 AND source_type = 'document'`,
      [organizationId]
    ),
    pool.query<{
      total: number;
      errors: number;
      warnings: number;
      last_seen_at: string | null;
    }>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE lower(level) = 'error')::int AS errors,
         COUNT(*) FILTER (WHERE lower(level) IN ('warn', 'warning'))::int AS warnings,
         MAX(timestamp) AS last_seen_at
       FROM logs
       WHERE organization_id = $1`,
      [organizationId]
    ),
    pool.query<{ key: string; count: number }>(
      `SELECT COALESCE(lower(level), 'info') AS key, COUNT(*)::int AS count
       FROM logs
       WHERE organization_id = $1
       GROUP BY 1`,
      [organizationId]
    ),
    pool.query<{
      total: number;
      open: number;
      urgent_open: number;
      last_created_at: string | null;
    }>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE COALESCE(lower(status), 'open') NOT IN ('resolved', 'closed'))::int AS open,
         COUNT(*) FILTER (
           WHERE COALESCE(lower(priority), 'medium') IN ('urgent', 'critical', 'high')
             AND COALESCE(lower(status), 'open') NOT IN ('resolved', 'closed')
         )::int AS urgent_open,
         MAX(created_at) AS last_created_at
       FROM tickets
       WHERE organization_id = $1`,
      [organizationId]
    ),
    pool.query<{ key: string; count: number }>(
      `SELECT COALESCE(lower(status), 'open') AS key, COUNT(*)::int AS count
       FROM tickets
       WHERE organization_id = $1
       GROUP BY 1`,
      [organizationId]
    ),
    pool.query<{ key: string; count: number }>(
      `SELECT COALESCE(lower(priority), 'medium') AS key, COUNT(*)::int AS count
       FROM tickets
       WHERE organization_id = $1
       GROUP BY 1`,
      [organizationId]
    ),
  ]);

  const documents = documentsResult.rows[0];
  const logs = logsResult.rows[0];
  const tickets = ticketsResult.rows[0];

  return {
    documents: {
      total: Number(documents?.total ?? 0),
      processed: Number(documents?.processed ?? 0),
      processing: Number(documents?.processing ?? 0),
      pending: Number(documents?.pending ?? 0),
      failed: Number(documents?.failed ?? 0),
      chunks: Number(chunksResult.rows[0]?.chunks ?? 0),
      lastIngestedAt: documents?.last_ingested_at ?? null,
    },
    logs: {
      total: Number(logs?.total ?? 0),
      errors: Number(logs?.errors ?? 0),
      warnings: Number(logs?.warnings ?? 0),
      lastSeenAt: logs?.last_seen_at ?? null,
      byLevel: toCountMap(logLevelsResult.rows),
    },
    tickets: {
      total: Number(tickets?.total ?? 0),
      open: Number(tickets?.open ?? 0),
      urgentOpen: Number(tickets?.urgent_open ?? 0),
      lastCreatedAt: tickets?.last_created_at ?? null,
      byStatus: toCountMap(ticketStatusResult.rows),
      byPriority: toCountMap(ticketPriorityResult.rows),
    },
  };
}
