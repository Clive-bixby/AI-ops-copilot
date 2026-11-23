import { Router } from "express";

import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import {
  getIngestionJobController,
  ingestionHealthController,
  listIngestionJobsController,
  reindexController,
} from "./ingestion.controller.js";

const ingestionRouter = Router();

ingestionRouter.get(
  "/health",
  authMiddleware,
  orgMiddleware,
  ingestionHealthController
);
ingestionRouter.get(
  "/jobs",
  authMiddleware,
  orgMiddleware,
  listIngestionJobsController
);
ingestionRouter.get(
  "/jobs/:id",
  authMiddleware,
  orgMiddleware,
  getIngestionJobController
);
ingestionRouter.post(
  "/reindex",
  authMiddleware,
  orgMiddleware,
  reindexController
);

export default ingestionRouter;
