import express from "express";
import type { Request, Response } from "express";
import cors from "cors";

import { pool } from "./core/db.js";
import authRouter from "./modules/auth/auth.routes.js";
import { authMiddleware } from "./middleware/auth.middleware.js";
import { errorMiddleware } from "./middleware/error.middleware.js";
import adminRouter from "./modules/admin/admin.routes.js";
import documentsRouter from "./modules/documents/documents.routes.js";
import logsRouter from "./modules/logs/logs.routes.js";
import ticketsRouter from "./modules/tickets/tickets.routes.js";
import aiRouter from "./modules/ai/ai.routes.js";
import insightsRouter from "./modules/insights/insights.routes.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);

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

    console.error("[health] database probe failed", error);

    return {
      status: "down",
      latencyMs: Date.now() - startedAt,
      error: message,
    };
  }
}

app.use(cors());
app.use(express.json());

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
app.use("/documents", documentsRouter);
app.use("/logs", logsRouter);
app.use("/tickets", ticketsRouter);
app.use("/ai", aiRouter);
app.use("/insights", insightsRouter);
app.use(adminRouter);
app.use(errorMiddleware);

app.get("/protected", authMiddleware, (req, res) => {
  res.json({ message: "You are authenticated" })
})

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM signal received: shutting down");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT signal received: shutting down");
  process.exit(0);
});
