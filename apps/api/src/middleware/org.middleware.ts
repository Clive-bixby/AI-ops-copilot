import type { NextFunction, Request, Response } from "express";

import { pool } from "../core/db.js";

type MembershipRole = "owner" | "admin" | "member";

declare global {
  namespace Express {
    interface Request {
      organizationId?: string;
      role?: MembershipRole;
    }
  }
}

export async function orgMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const orgId = req.header("x-organization-id");

  if (!orgId) {
    return res.status(400).json({
      error: "Organization ID header missing",
    });
  }

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  try {
    const result = await pool.query<{ role: MembershipRole }>(
      `
      SELECT role
      FROM memberships
      WHERE user_id=$1 AND organization_id=$2
      `,
      [userId, orgId]
    );

    const membership = result.rows[0];
    if (!membership) {
      return res.status(403).json({
        error: "User not part of this organization",
      });
    }

    req.organizationId = orgId;
    req.role = membership.role;

    return next();
  } catch (error) {
    return next(error);
  }
}

