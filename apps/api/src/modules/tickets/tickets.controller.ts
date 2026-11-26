import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import { readListPagination } from "../../utils/pagination.js";
import { hashContent } from "../ingestion/embeddingConfig.js";
import { runIdempotent } from "../ingestion/idempotency.service.js";
import { getTicket, ingestTickets, listTickets } from "./tickets.service.js";

export const ingestTicketsController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const result = await runIdempotent({
    organizationId,
    endpoint: "tickets.ingest",
    key: req.header("idempotency-key"),
    requestHash: hashContent(JSON.stringify(req.body ?? {})),
    handler: async () => {
      const ingested = await ingestTickets(organizationId, req.body);

      return {
        status: 201,
        body: {
          count: ingested.tickets.length,
          tickets: ingested.tickets,
          jobsQueued: ingested.jobsQueued,
          indexingError: ingested.indexingError,
        },
      };
    },
  });

  if (result.replayed) {
    res.set("Idempotency-Replayed", "true");
  }

  return res.status(result.status).json(result.body);
});

export const listTicketsController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const tickets = await listTickets(
    organizationId,
    readListPagination(req.query)
  );
  return res.status(200).json(tickets);
});

export const getTicketController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const rawId = req.params.id;
  const ticketId = Array.isArray(rawId) ? rawId[0] ?? "" : rawId ?? "";

  const ticket = await getTicket(organizationId, ticketId);
  if (!ticket) {
    throw createHttpError(404, "Ticket not found");
  }

  return res.status(200).json(ticket);
});
