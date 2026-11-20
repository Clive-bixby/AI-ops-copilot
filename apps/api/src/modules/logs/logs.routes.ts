import { Router } from "express";

import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import {
  getLogGroupController,
  ingestLogsController,
  listLogsController,
} from "./logs.controller.js";

const logsRouter = Router();

logsRouter.get("/", authMiddleware, orgMiddleware, listLogsController);
logsRouter.post("/ingest", authMiddleware, orgMiddleware, ingestLogsController);
logsRouter.get(
  "/groups/:id",
  authMiddleware,
  orgMiddleware,
  getLogGroupController
);

export default logsRouter;
