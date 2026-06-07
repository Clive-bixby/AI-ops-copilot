import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import { ingestTickets, listTickets } from "./tickets.service.js";

export const ingestTicketsController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const tickets = await ingestTickets(organizationId, req.body);

  return res.status(201).json({
    count: tickets.length,
    tickets,
  });
});

export const listTicketsController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const tickets = await listTickets(organizationId);
  return res.status(200).json(tickets);
});
