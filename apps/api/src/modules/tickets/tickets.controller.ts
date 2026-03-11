import type { Request, Response } from "express";

import {
  ingestTickets,
  TicketParseError,
  TicketsValidationError,
} from "./tickets.service.js";

export async function ingestTicketsController(req: Request, res: Response) {
  try {
    const organizationId = req.organizationId;
    if (!organizationId) {
      return res.status(400).json({ error: "Organization ID is required" });
    }

    const tickets = await ingestTickets(organizationId, req.body);

    return res.status(201).json({
      count: tickets.length,
      tickets,
    });
  } catch (error) {
    if (error instanceof TicketsValidationError || error instanceof TicketParseError) {
      return res.status(400).json({ error: error.message });
    }

    const unknownError =
      error instanceof Error ? error : new Error("Unknown error");
    console.error("Ticket ingestion failed:", unknownError);
    return res.status(500).json({ error: "Internal server error" });
  }
}
