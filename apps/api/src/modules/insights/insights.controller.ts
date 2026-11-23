import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import { getOverview } from "./insights.service.js";
import {
  getOperationsOverview,
  listOperationsActionItems,
} from "./operations.service.js";

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

export const overviewController = asyncHandler(async (req, res) => {
  const organizationId = requireOrganization(req.organizationId);
  const overview = await getOverview(organizationId);
  return res.status(200).json(overview);
});

/** GET /insights/operations — counts and groupings for the overview tab. */
export const operationsOverviewController = asyncHandler(async (req, res) => {
  const organizationId = requireOrganization(req.organizationId);
  const userId = requireUserId(req.user?.id);

  const overview = await getOperationsOverview({ organizationId, userId });

  return res.status(200).json(overview);
});

/** GET /insights/action-items — the organization-wide action-item queue. */
export const operationsActionItemsController = asyncHandler(async (req, res) => {
  const organizationId = requireOrganization(req.organizationId);
  const userId = requireUserId(req.user?.id);

  const list = await listOperationsActionItems({
    organizationId,
    userId,
    query: req.query,
  });

  return res.status(200).json(list);
});
