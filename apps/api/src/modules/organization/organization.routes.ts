import { Router } from "express";

import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import { listOrganizationMembersController } from "./organization.controller.js";

const organizationRouter = Router();

// Every member can see the people they may assign work to. `/admin/members`
// stays owner/admin-only because it is part of the administration surface.
organizationRouter.get(
  "/members",
  authMiddleware,
  orgMiddleware,
  listOrganizationMembersController
);

export default organizationRouter;
