import { pool } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { hashContent } from "../ingestion/embeddingConfig.js";
import { enqueueIngestionJob } from "../ingestion/jobQueue.js";
import { parseRawTickets, TicketParseError } from "./ticket.parser.js";
import { renderTicketContent } from "../ingestion/ticketIngest.service.js";

type StoredTicketRow = {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  created_at: string;
};

export class TicketsValidationError extends Error {}
export { TicketParseError };

export type IngestTicketsResult = {
  tickets: Array<{
    id: string;
    organizationId: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    createdAt: string;
  }>;
  jobsQueued: number;
  indexingError: string | null;
};

export async function ingestTickets(
  organizationId: string,
  payload: unknown
): Promise<IngestTicketsResult> {
  const orgId = (organizationId || "").trim();
  if (!orgId) {
    throw new TicketsValidationError("Organization ID is required");
  }

  const normalizedTickets = parseRawTickets(payload);

  // One multi-row INSERT for the whole batch (see logs.service.ts).
  const values: unknown[] = [];
  const placeholders: string[] = [];

  normalizedTickets.forEach((ticket, index) => {
    const base = index * 6;
    values.push(
      orgId,
      ticket.title,
      ticket.description,
      ticket.status,
      ticket.priority,
      hashContent(renderTicketContent(ticket))
    );
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`
    );
  });

  const result = await pool.query<StoredTicketRow>(
    `
    INSERT INTO tickets (organization_id, title, description, status, priority, content_hash)
    VALUES ${placeholders.join(", ")}
    RETURNING id, organization_id, title, description, status, priority, created_at
    `,
    values
  );

  const tickets = result.rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    title: row.title,
    description: row.description || "",
    status: row.status,
    priority: row.priority,
    createdAt: row.created_at,
  }));

  let jobsQueued = 0;
  let indexingError: string | null = null;

  for (const ticket of tickets) {
    try {
      await enqueueIngestionJob({
        organizationId: orgId,
        sourceType: "ticket",
        sourceId: ticket.id,
      });
      jobsQueued += 1;
    } catch (error) {
      indexingError =
        error instanceof Error ? error.message : "Could not queue indexing";
      logger.error("ingestion.ticket_enqueue_failed", {
        organizationId: orgId,
        ticketId: ticket.id,
        error,
      });
    }
  }

  return { tickets, jobsQueued, indexingError };
}

export async function listTickets(organizationId: string) {
  const result = await pool.query<StoredTicketRow>(
    `SELECT id, organization_id, title, description, status, priority, created_at
     FROM tickets
     WHERE organization_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [organizationId]
  );
  return result.rows;
}

export async function getTicket(
  organizationId: string,
  ticketId: string
): Promise<StoredTicketRow | null> {
  const result = await pool.query<StoredTicketRow>(
    `SELECT id, organization_id, title, description, status, priority, created_at
     FROM tickets
     WHERE id = $1 AND organization_id = $2`,
    [ticketId, organizationId]
  );

  return result.rows[0] ?? null;
}
