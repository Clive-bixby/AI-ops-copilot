import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import { listOrganizationMembers } from "./organization.service.js";

export const listOrganizationMembersController = asyncHandler(
  async (req, res) => {
    const organizationId = req.organizationId;

    if (!organizationId) {
      throw createHttpError(400, "Organization ID is required");
    }

    const members = await listOrganizationMembers(organizationId);

    return res.status(200).json({
      organizationId,
      total: members.length,
      members,
    });
  }
);
