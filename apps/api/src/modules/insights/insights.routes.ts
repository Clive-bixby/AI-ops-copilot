import { Router } from "express";

import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import {
  operationsActionItemsController,
  operationsOverviewController,
  overviewController,
} from "./insights.controller.js";

const insightsRouter = Router();

insightsRouter.get(
  "/overview",
  authMiddleware,
  orgMiddleware,
  overviewController
);

// Operational overview: counts, groupings and the recent work lists. Every
// number is scoped to the caller's organization.
insightsRouter.get(
  "/operations",
  authMiddleware,
  orgMiddleware,
  operationsOverviewController
);

// The cross-investigation action-item queue. Filters and pagination are applied
// in SQL; the summary is organization-wide.
insightsRouter.get(
  "/action-items",
  authMiddleware,
  orgMiddleware,
  operationsActionItemsController
);

export default insightsRouter;
