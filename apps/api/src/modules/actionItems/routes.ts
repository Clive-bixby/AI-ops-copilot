import { Router } from "express";

import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import {
  createActionItemController,
  getActionItemController,
  listActionItemsController,
  updateActionItemController,
} from "./controller.js";

/**
 * Mounted at `/investigations/:id/action-items`.
 *
 * `mergeParams` keeps the parent investigation id available, so every action
 * item query is scoped by both the item and its investigation in one predicate.
 */
const actionItemsRouter = Router({ mergeParams: true });

actionItemsRouter.get(
  "/",
  authMiddleware,
  orgMiddleware,
  listActionItemsController
);

actionItemsRouter.post(
  "/",
  authMiddleware,
  orgMiddleware,
  createActionItemController
);

actionItemsRouter.get(
  "/:actionItemId",
  authMiddleware,
  orgMiddleware,
  getActionItemController
);

actionItemsRouter.patch(
  "/:actionItemId",
  authMiddleware,
  orgMiddleware,
  updateActionItemController
);

export default actionItemsRouter;
