import express from "express";
import type { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";

import { pool } from "./core/db.js";
import { logger } from "./core/logger.js";
import { JSON_BODY_LIMIT, resolveAllowedOrigins } from "./config/security.js";
import authRouter from "./modules/auth/auth.routes.js";
import { authMiddleware } from "./middleware/auth.middleware.js";
import { errorMiddleware } from "./middleware/error.middleware.js";
import { notFoundMiddleware } from "./middleware/notFound.middleware.js";
import { requestLogMiddleware } from "./middleware/requestLog.middleware.js";
import { apiRateLimiter } from "./middleware/rateLimit.middleware.js";
import adminRouter from "./modules/admin/admin.routes.js";
import documentsRouter from "./modules/documents/documents.routes.js";
import logsRouter from "./modules/logs/logs.routes.js";
import ticketsRouter from "./modules/tickets/tickets.routes.js";
import aiRouter from "./modules/ai/ai.routes.js";
import insightsRouter from "./modules/insights/insights.routes.js";
import ingestionRouter from "./modules/ingestion/ingestion.routes.js";
import investigationsRouter from "./modules/investigations/investigation.routes.js";
import organizationRouter from "./modules/organization/organization.routes.js";

type DependencyCheck = {
  status: "up" | "down";
  latencyMs: number;
  error?: string;
};

/** A dependency probe must never hang a health check. */
const HEALTH_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Actually query Postgres instead of assuming it is there. A health endpoint
 * that reports "healthy" while the database is down is worse than no health
 * endpoint, because the orchestrator keeps routing traffic to a broken process.
 */
async function checkDatabase(): Promise<DependencyCheck> {
  const startedAt = Date.now();

  try {
    await withTimeout(pool.query("SELECT 1"), HEALTH_TIMEOUT_MS);

    return { status: "up", latencyMs: Date.now() - startedAt };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Database check failed";

    logger.error("health.database_probe_failed", { error });

    return {
      status: "down",
      latencyMs: Date.now() - startedAt,
      error: message,
    };
  }
}

export type CreateAppOptions = {
  /**
   * Integration tests make many requests from one address; the production
   * limiter would turn a green suite into a 429. This never defaults to true.
   */
  disableRateLimit?: boolean;
};

/**
 * Build the Express application without binding a port. Keeping the process
 * entry (`index.ts`) separate lets tests start the real routes on an ephemeral
 * port instead of testing a hand-built subset.
 */
export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();
  const allowedOrigins = resolveAllowedOrigins();

  // Behind a reverse proxy the client IP lives in X-Forwarded-For; without this,
  // rate limiting would key every client on the proxy address.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy) {
    app.set("trust proxy", trustProxy);
  }

  app.use(requestLogMiddleware);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin(
        origin: string | undefined,
        callback: (error: Error | null, allow?: boolean) => void
      ) {
        // No Origin header: curl, server-to-server, same-origin navigation.
        if (!origin) {
          return callback(null, true);
        }

        return callback(null, allowedOrigins.includes(origin));
      },
    })
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  if (!options.disableRateLimit) {
    app.use(apiRateLimiter);
  }

  app.get("/", (req: Request, res: Response) => {
    res.json({
      message: "AI Ops Copilot API is running!",
      status: "success",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/health", async (req: Request, res: Response) => {
    const database = await checkDatabase();
    const healthy = database.status === "up";

    res
      .status(healthy ? 200 : 503)
      .set("Cache-Control", "no-store")
      .json({
        status: healthy ? "healthy" : "unhealthy",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        checks: { database },
      });
  });

  app.get("/api/status", (req: Request, res: Response) => {
    res.json({
      service: "ai-ops-copilot",
      version: "1.0.0",
      environment: process.env.NODE_ENV || "development",
    });
  });

  app.use("/auth", authRouter);
  app.use("/admin", adminRouter);
  app.use("/organization", organizationRouter);
  app.use("/documents", documentsRouter);
  app.use("/logs", logsRouter);
  app.use("/tickets", ticketsRouter);
  app.use("/ai", aiRouter);
  app.use("/insights", insightsRouter);
  app.use("/ingestion", ingestionRouter);
  app.use("/investigations", investigationsRouter);

  app.get("/protected", authMiddleware, (req, res) => {
    res.json({ message: "You are authenticated" });
  });

  // Order matters: unknown routes get a JSON 404, and the error handler is last
  // so it can catch failures from every route above it.
  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
