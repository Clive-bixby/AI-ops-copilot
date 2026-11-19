import { Router } from "express";

import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import { overviewController } from "./insights.controller.js";

const insightsRouter = Router();

insightsRouter.get(
  "/overview",
  authMiddleware,
  orgMiddleware,
  overviewController
);

export default insightsRouter;
