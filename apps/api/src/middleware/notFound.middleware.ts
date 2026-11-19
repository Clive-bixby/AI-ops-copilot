import type { Request, Response } from "express";

/**
 * JSON 404 for unknown routes. Without this, Express falls through to its HTML
 * error page, which is unusable for API clients.
 */
export function notFoundMiddleware(req: Request, res: Response) {
  res.status(404).json({
    error: `Route ${req.method} ${req.originalUrl} not found`,
  });
}
