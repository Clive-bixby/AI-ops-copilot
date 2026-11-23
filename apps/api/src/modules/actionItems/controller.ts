import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import {
  createActionItem,
  getActionItemDetail,
  listActionItems,
  updateActionItem,
} from "./service.js";

function requireOrganization(organizationId: string | undefined): string {
  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  return organizationId;
}

function requireUserId(userId: string | undefined): string {
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  return userId;
}

function readRouteId(value: unknown): string {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }

  return typeof value === "string" ? value : "";
}

/** GET /investigations/:id/action-items — scoped to one investigation. */
export const listActionItemsController = asyncHandler(async (req, res) => {
  const organizationId = requireOrganization(req.organizationId);
  const userId = requireUserId(req.user?.id);

  const result = await listActionItems({
    organizationId,
    investigationId: readRouteId(req.params.id),
    userId,
    query: req.query,
  });

  return res.status(200).json(result);
});

/** POST /investigations/:id/action-items — a person writes the item. */
export const createActionItemController = asyncHandler(async (req, res) => {
  const organizationId = requireOrganization(req.organizationId);
  const userId = requireUserId(req.user?.id);

  const detail = await createActionItem({
    organizationId,
    investigationId: readRouteId(req.params.id),
    userId,
    payload: req.body,
  });

  return res.status(201).json(detail);
});

/** GET /investigations/:id/action-items/:actionItemId — item and its history. */
export const getActionItemController = asyncHandler(async (req, res) => {
  const organizationId = requireOrganization(req.organizationId);

  const detail = await getActionItemDetail({
    organizationId,
    investigationId: readRouteId(req.params.id),
    actionItemId: readRouteId(req.params.actionItemId),
  });

  return res.status(200).json(detail);
});

/** PATCH /investigations/:id/action-items/:actionItemId */
export const updateActionItemController = asyncHandler(async (req, res) => {
  const organizationId = requireOrganization(req.organizationId);
  const userId = requireUserId(req.user?.id);

  const detail = await updateActionItem({
    organizationId,
    investigationId: readRouteId(req.params.id),
    actionItemId: readRouteId(req.params.actionItemId),
    userId,
    payload: req.body,
  });

  return res.status(200).json(detail);
});
