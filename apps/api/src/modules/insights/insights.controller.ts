import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import { getOverview } from "./insights.service.js";

export const overviewController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;

  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const overview = await getOverview(organizationId);
  return res.status(200).json(overview);
});
