import express from "express";

import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import { requireRole } from "../../middleware/rbac.middleware.js";

const router = express.Router();

const adminTestHandler = (req: express.Request, res: express.Response) => {
  res.json({
    message: "Admin access granted",
    userId: req.user?.id,
    organizationId: req.organizationId,
    role: req.role,
  });
};

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

export default router;
