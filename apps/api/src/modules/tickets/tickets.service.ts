import { pool } from "../../core/db.js";
import { parseRawTickets, TicketParseError } from "./ticket.parser.js";

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

export async function ingestTickets(organizationId: string, payload: unknown) {
  const orgId = (organizationId || "").trim();
  if (!orgId) {
    throw new TicketsValidationError("Organization ID is required");
  }

  const normalizedTickets = parseRawTickets(payload);

  // One multi-row INSERT for the whole batch (see logs.service.ts).
  const values: unknown[] = [];
  const placeholders: string[] = [];

  normalizedTickets.forEach((ticket, index) => {
    const base = index * 5;
    values.push(
      orgId,
      ticket.title,
      ticket.description,
      ticket.status,
      ticket.priority
    );
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`
    );
  });

  const result = await pool.query<StoredTicketRow>(
    `
    INSERT INTO tickets (organization_id, title, description, status, priority)
    VALUES ${placeholders.join(", ")}
    RETURNING id, organization_id, title, description, status, priority, created_at
    `,
    values
  );

  return result.rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    title: row.title,
    description: row.description || "",
    status: row.status,
    priority: row.priority,
    createdAt: row.created_at,
  }));
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
