import { Router } from "express";

import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import {
  getTicketController,
  ingestTicketsController,
  listTicketsController,
} from "./tickets.controller.js";

const ticketsRouter = Router();

ticketsRouter.get("/", authMiddleware, orgMiddleware, listTicketsController);
ticketsRouter.post(
  "/ingest",
  authMiddleware,
  orgMiddleware,
  ingestTicketsController
);
ticketsRouter.get("/:id", authMiddleware, orgMiddleware, getTicketController);

export default ticketsRouter;
