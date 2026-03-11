import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import { ingestLogs } from "./logs.service.js";

export const ingestLogsController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const logs = await ingestLogs(organizationId, req.body);

  return res.status(201).json({
    count: logs.length,
    logs,
  });
});
