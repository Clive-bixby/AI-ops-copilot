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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const storedTickets: Array<{
      id: string;
      organizationId: string;
      title: string;
      description: string;
      status: string;
      priority: string;
      createdAt: string;
    }> = [];

    for (const ticket of normalizedTickets) {
      const result = await client.query<StoredTicketRow>(
        `
        INSERT INTO tickets (organization_id, title, description, status, priority)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, organization_id, title, description, status, priority, created_at
        `,
        [
          orgId,
          ticket.title,
          ticket.description,
          ticket.status,
          ticket.priority,
        ]
      );

      const storedTicket = result.rows[0];
      if (!storedTicket) {
        throw new Error("Failed to store ticket");
      }

      storedTickets.push({
        id: storedTicket.id,
        organizationId: storedTicket.organization_id,
        title: storedTicket.title,
        description: storedTicket.description || "",
        status: storedTicket.status,
        priority: storedTicket.priority,
        createdAt: storedTicket.created_at,
      });
    }

    await client.query("COMMIT");
    return storedTickets;
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
