import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import { readListPagination } from "../../utils/pagination.js";
import { hashContent } from "../ingestion/embeddingConfig.js";
import { runIdempotent } from "../ingestion/idempotency.service.js";
import { getLogGroup, ingestLogs, listLogs } from "./logs.service.js";

export const ingestLogsController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const result = await runIdempotent({
    organizationId,
    endpoint: "logs.ingest",
    key: req.header("idempotency-key"),
    requestHash: hashContent(JSON.stringify(req.body ?? {})),
    handler: async () => {
      const ingested = await ingestLogs(organizationId, req.body);

      return {
        status: 201,
        body: {
          count: ingested.logs.length,
          logs: ingested.logs,
          duplicates: ingested.duplicates,
          groupsTouched: ingested.groupsTouched,
          jobsQueued: ingested.jobsQueued,
          indexingError: ingested.indexingError,
        },
      };
    },
  });

  if (result.replayed) {
    res.set("Idempotency-Replayed", "true");
  }

  return res.status(result.status).json(result.body);
});

export const listLogsController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const logs = await listLogs(organizationId, readListPagination(req.query));
  return res.status(200).json(logs);
});

export const getLogGroupController = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  const rawId = req.params.id;
  const groupId = Array.isArray(rawId) ? rawId[0] ?? "" : rawId ?? "";

  const result = await getLogGroup(organizationId, groupId);
  if (!result) {
    throw createHttpError(404, "Log group not found");
  }

  return res.status(200).json({
    id: result.group.id,
    level: result.group.level,
    service: result.group.service,
    template: result.group.template,
    windowStart: result.group.window_start,
    windowEnd: result.group.window_end,
    eventCount: result.group.event_count,
    firstSeen: result.group.first_seen,
    lastSeen: result.group.last_seen,
    embeddingStatus: result.group.embedding_status,
    sampleLogIds: result.group.sample_log_ids,
    sampleLogs: result.sampleLogs,
  });
});
