import express from "express";
import type { Request, Response } from "express";

import { pool } from "./core/db.js";
import authRouter from "./modules/auth/auth.routes.js";
import { authMiddleware } from "./middleware/auth.middleware.js";
import adminRouter from "./modules/admin/admin.routes.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());

app.get("/", (req: Request, res: Response) => {
  res.json({
    message: "AI Ops Copilot API is running!",
    status: "success",
    timestamp: new Date().toISOString(),
  });
});

app.get("/test-db", async (req: Request, res: Response) => {
  const result = await pool.query("SELECT NOW()");
  res.json(result.rows);
});

app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
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
app.use(adminRouter);

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
