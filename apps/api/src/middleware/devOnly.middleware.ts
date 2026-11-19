import type { NextFunction, Request, Response } from "express";

import { ENABLE_DEV_ENDPOINTS } from "../config/security.js";

/**
 * Dark-launch test routes. When ENABLE_DEV_ENDPOINTS is not "true" they answer
 * 404 (not 403) so a disabled endpoint does not advertise that it exists.
 */
export function devOnlyMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  if (ENABLE_DEV_ENDPOINTS) {
    return next();
  }

  return res.status(404).json({ error: "Not found" });
}
