import type { Request, Response } from "express";

import { ingestLogs, LogParseError, LogsValidationError } from "./logs.service.js";

export async function ingestLogsController(req: Request, res: Response) {
  try {
    const organizationId = req.organizationId;
    if (!organizationId) {
      return res.status(400).json({ error: "Organization ID is required" });
    }

    const logs = await ingestLogs(organizationId, req.body);

    return res.status(201).json({
      count: logs.length,
      logs,
    });
  } catch (error) {
    if (error instanceof LogsValidationError || error instanceof LogParseError) {
      return res.status(400).json({ error: error.message });
    }

    const unknownError =
      error instanceof Error ? error : new Error("Unknown error");
    console.error("Log ingestion failed:", unknownError);
    return res.status(500).json({ error: "Internal server error" });
  }
}
