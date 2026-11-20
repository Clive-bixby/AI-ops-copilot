import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import { logger } from "../core/logger.js";

declare global {
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}

/** Accept a caller-supplied id only if it cannot poison the log stream. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Health checks run every few seconds; logging them buries real requests. */
const SKIPPED_PATHS = new Set(["/health"]);

export function resolveRequestId(header: string | undefined): string {
  if (header && SAFE_REQUEST_ID.test(header)) {
    return header;
  }

  return randomUUID();
}

/**
 * Attach a request id, echo it to the caller, and emit one structured line per
 * request with status and duration. The id is also what the error handler
 * reports, so a 500 a user quotes can be found in the logs.
 */
export function requestLogMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const requestId = resolveRequestId(req.header("x-request-id"));
  req.id = requestId;
  res.setHeader("x-request-id", requestId);

  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    if (SKIPPED_PATHS.has(req.path)) {
      return;
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const fields: Record<string, unknown> = {
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
    };

    if (req.organizationId) {
      fields.organizationId = req.organizationId;
    }

    if (req.user?.id) {
      fields.userId = req.user.id;
    }

    if (res.statusCode >= 500) {
      logger.error("request.failed", fields);
    } else if (res.statusCode >= 400) {
      logger.warn("request.rejected", fields);
    } else {
      logger.info("request.completed", fields);
    }
  });

  next();
}
