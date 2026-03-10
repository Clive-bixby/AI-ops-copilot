import { Router } from "express";

import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import { ingestLogsController } from "./logs.controller.js";

const logsRouter = Router();

logsRouter.post("/ingest", authMiddleware, orgMiddleware, ingestLogsController);

export default logsRouter;
