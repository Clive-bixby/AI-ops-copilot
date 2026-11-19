import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import { getSessionContext, login, register } from "./auth.service.js";

export const registerController = asyncHandler(async (req, res) => {
  const result = await register(req.body);
  return res.status(201).json(result);
});

export const loginController = asyncHandler(async (req, res) => {
  const result = await login(req.body);
  return res.status(200).json(result);
});

/**
 * GET /auth/me
 *
 * Returns the authenticated user, the active organization resolved by
 * orgMiddleware, and the caller's membership role in that organization.
 */
export const meController = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  const organizationId = req.organizationId;

  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  if (!organizationId) {
    throw createHttpError(400, "Organization ID header missing");
  }

  const session = await getSessionContext(
    userId,
    organizationId,
    req.role ?? "member"
  );

  return res.status(200).json(session);
});
