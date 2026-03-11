import { Router } from "express";

import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import { ingestTicketsController } from "./tickets.controller.js";

const ticketsRouter = Router();

ticketsRouter.post("/ingest", authMiddleware, orgMiddleware, ingestTicketsController);

export default ticketsRouter;
