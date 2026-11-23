import express from "express";

import { ENABLE_DEV_ENDPOINTS } from "../../config/security.js";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import { requireRole } from "../../middleware/rbac.middleware.js";
import { listMembersController } from "./admin.controller.js";

const router = express.Router();

const adminTestHandler = (req: express.Request, res: express.Response) => {
  res.json({
    message: "Admin access granted",
    userId: req.user?.id,
    organizationId: req.organizationId,
    role: req.role,
  });
};

// Echoes the resolved identity. Useful while wiring the client, no value in a
// deployment, and it stays dark like the /ai/test-* routes.
if (ENABLE_DEV_ENDPOINTS) {
  router.get(
    "/admin-test",
    authMiddleware,
    orgMiddleware,
    requireRole(["owner", "admin"]),
    adminTestHandler
  );

  router.post(
    "/admin-test",
    authMiddleware,
    orgMiddleware,
    requireRole(["owner", "admin"]),
    adminTestHandler
  );
}

// Organization membership directory. Read-only: invitations and role changes
// are not part of the current backend contract.
router.get(
  "/members",
  authMiddleware,
  orgMiddleware,
  requireRole(["owner", "admin"]),
  listMembersController
);

export default router;
