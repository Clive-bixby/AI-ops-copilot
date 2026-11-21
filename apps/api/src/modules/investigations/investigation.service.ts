import { pool } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { listActivity, insertActivity } from "./activity.service.js";
import { listEvidenceForInvestigation } from "./evidence.service.js";
import {
  InvestigationConflictError,
  InvestigationNotFoundError,
} from "./errors.js";
import {
  applyStatusChange,
  assertWindowOrder,
  normalizeInvestigationId,
  validateCreateInvestigation,
  validateListInvestigationsQuery,
  validateNoteBody,
  validateUpdateInvestigation,
} from "./policy.js";
import type {
  InvestigationSeverity,
  InvestigationSourceType,
  InvestigationStatus,
} from "./policy.js";
import type {
  Investigation,
  InvestigationActivity,
  InvestigationDetail,
  InvestigationList,
} from "./types.js";

type InvestigationRow = {
  id: string;
  organization_id: string;
  title: string;
  description: string;
  status: string;
  severity: string;
  service: string | null;
  error_signature: string | null;
  window_start: Date | string | null;
  window_end: Date | string | null;
  source_types: string[] | null;
  resolution_summary: string | null;
  created_by: string;
  created_by_email: string | null;
  resolved_at: Date | string | null;
  closed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type InvestigationListRow = InvestigationRow & {
  total_count: string | number;
};

const INVESTIGATION_SELECT = `
  SELECT
    i.id,
    i.organization_id,
    i.title,
    i.description,
    i.status,
    i.severity,
    i.service,
    i.error_signature,
    i.window_start,
    i.window_end,
    i.source_types,
    i.resolution_summary,
    i.created_by,
    u.email AS created_by_email,
    i.resolved_at,
    i.closed_at,
    i.created_at,
    i.updated_at
  FROM investigations i
  LEFT JOIN users u ON u.id = i.created_by
`;

function toIso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapInvestigation(row: InvestigationRow): Investigation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    title: row.title,
    description: row.description,
    status: row.status as InvestigationStatus,
    severity: row.severity as InvestigationSeverity,
    service: row.service,
    errorSignature: row.error_signature,
    windowStart: toIso(row.window_start),
    windowEnd: toIso(row.window_end),
    sourceTypes: (row.source_types as InvestigationSourceType[] | null) ?? null,
    resolutionSummary: row.resolution_summary,
    createdBy: row.created_by,
    createdByEmail: row.created_by_email,
    resolvedAt: toIso(row.resolved_at),
    closedAt: toIso(row.closed_at),
    createdAt: toIso(row.created_at) ?? "",
    updatedAt: toIso(row.updated_at) ?? "",
  };
}

export async function getInvestigationDetail(
  organizationId: string,
  rawInvestigationId: string,
  activityLimit = 100
): Promise<InvestigationDetail> {
  const investigationId = normalizeInvestigationId(rawInvestigationId);

  const result = await pool.query<InvestigationRow>(
    `${INVESTIGATION_SELECT} WHERE i.id = $1 AND i.organization_id = $2`,
    [investigationId, organizationId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new InvestigationNotFoundError();
  }

  const [activity, evidence] = await Promise.all([
    listActivity(organizationId, investigationId, activityLimit),
    listEvidenceForInvestigation(organizationId, investigationId),
  ]);

  return { investigation: mapInvestigation(row), activity, evidence };
}

export async function createInvestigation(input: {
  organizationId: string;
  userId: string;
  payload: unknown;
}): Promise<{ detail: InvestigationDetail; collectEvidenceRequested: boolean }> {
  const parsed = validateCreateInvestigation(input.payload);
  const client = await pool.connect();

  let investigationId: string | null = null;

  try {
    await client.query("BEGIN");

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO investigations (
         organization_id, title, description, severity, service, error_signature,
         window_start, window_end, source_types, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10)
       RETURNING id`,
      [
        input.organizationId,
        parsed.title,
        parsed.description,
        parsed.severity,
        parsed.service,
        parsed.errorSignature,
        parsed.windowStart,
        parsed.windowEnd,
        parsed.sourceTypes,
        input.userId,
      ]
    );

    const row = inserted.rows[0];
    if (!row) {
      throw new Error("Failed to create investigation");
    }

    const createdId = row.id;
    investigationId = createdId;

    await insertActivity(client, {
      investigationId: createdId,
      organizationId: input.organizationId,
      type: "created",
      actorUserId: input.userId,
      body: "Investigation created",
      metadata: {
        status: "open",
        severity: parsed.severity,
        service: parsed.service,
        windowStart: parsed.windowStart,
        windowEnd: parsed.windowEnd,
      },
    });

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (investigationId === null) {
    throw new Error("Failed to create investigation");
  }

  logger.info("investigation.created", {
    organizationId: input.organizationId,
    investigationId,
    userId: input.userId,
    severity: parsed.severity,
    collectEvidenceRequested: parsed.collectEvidence,
  });

  return {
    detail: await getInvestigationDetail(input.organizationId, investigationId),
    // Collection runs in the controller so a retrieval outage cannot fail the
    // creation that already committed.
    collectEvidenceRequested: parsed.collectEvidence,
  };
}

export async function listInvestigations(input: {
  organizationId: string;
  query: unknown;
}): Promise<InvestigationList> {
  const filters = validateListInvestigationsQuery(input.query);

  const result = await pool.query<InvestigationListRow>(
    `SELECT
       i.id,
       i.organization_id,
       i.title,
       i.description,
       i.status,
       i.severity,
       i.service,
       i.error_signature,
       i.window_start,
       i.window_end,
       i.source_types,
       i.resolution_summary,
       i.created_by,
       u.email AS created_by_email,
       i.resolved_at,
       i.closed_at,
       i.created_at,
       i.updated_at,
       COUNT(*) OVER() AS total_count
     FROM investigations i
     LEFT JOIN users u ON u.id = i.created_by
     WHERE i.organization_id = $1
       AND ($2::text IS NULL OR i.status = $2)
       AND ($3::text IS NULL OR i.severity = $3)
       AND ($4::text IS NULL OR LOWER(i.service) = LOWER($4))
       AND (
         $5::text IS NULL
         OR i.title ILIKE $5 ESCAPE '\\'
         OR i.description ILIKE $5 ESCAPE '\\'
       )
     ORDER BY i.updated_at DESC, i.id DESC
     LIMIT $6 OFFSET $7`,
    [
      input.organizationId,
      filters.status ?? null,
      filters.severity ?? null,
      filters.service ?? null,
      filters.q === undefined ? null : `%${escapeLike(filters.q)}%`,
      filters.limit,
      filters.offset,
    ]
  );

  return {
    investigations: result.rows.map(mapInvestigation),
    total: Number(result.rows[0]?.total_count ?? 0),
    limit: filters.limit,
    offset: filters.offset,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * Fields that may not be edited once an investigation is closed. A closed record
 * is history: it can be reopened, but its statement and scope cannot be rewritten
 * after the fact.
 */
const METADATA_FIELDS = [
  "title",
  "description",
  "severity",
  "service",
  "errorSignature",
  "windowStart",
  "windowEnd",
  "sourceTypes",
  "resolutionSummary",
] as const;

export async function updateInvestigation(input: {
  organizationId: string;
  investigationId: string;
  userId: string;
  payload: unknown;
}): Promise<InvestigationDetail> {
  const investigationId = normalizeInvestigationId(input.investigationId);
  const update = validateUpdateInvestigation(input.payload);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Lock the row: two concurrent PATCH requests must serialize so the
    // optimistic concurrency check and the transition rules cannot both pass on
    // stale state.
    const current = await client.query<InvestigationRow>(
      `${INVESTIGATION_SELECT}
       WHERE i.id = $1 AND i.organization_id = $2
       FOR UPDATE OF i`,
      [investigationId, input.organizationId]
    );

    const row = current.rows[0];
    if (!row) {
      throw new InvestigationNotFoundError();
    }

    if (update.expectedUpdatedAt !== undefined) {
      const expected = new Date(update.expectedUpdatedAt).getTime();
      const actual = new Date(row.updated_at).getTime();

      if (expected !== actual) {
        throw new InvestigationConflictError(
          "The investigation changed since it was loaded; reload it and retry"
        );
      }
    }

    const currentStatus = row.status as InvestigationStatus;

    if (currentStatus === "closed") {
      const editsMetadata = METADATA_FIELDS.some(
        (field) => update[field] !== undefined
      );

      if (editsMetadata) {
        throw new InvestigationConflictError(
          "A closed investigation can only be reopened"
        );
      }
    }

    const title = update.title ?? row.title;
    const description = update.description ?? row.description;
    const severity = (update.severity ?? row.severity) as InvestigationSeverity;
    const service = update.service === undefined ? row.service : update.service;
    const errorSignature =
      update.errorSignature === undefined
        ? row.error_signature
        : update.errorSignature;
    const windowStart =
      update.windowStart === undefined ? toIso(row.window_start) : update.windowStart;
    const windowEnd =
      update.windowEnd === undefined ? toIso(row.window_end) : update.windowEnd;
    const sourceTypes =
      update.sourceTypes === undefined
        ? (row.source_types as InvestigationSourceType[] | null)
        : update.sourceTypes;

    assertWindowOrder(windowStart, windowEnd);

    const lifecycle = applyStatusChange({
      current: {
        status: currentStatus,
        resolvedAt: toIso(row.resolved_at),
        closedAt: toIso(row.closed_at),
        resolutionSummary: row.resolution_summary,
      },
      request: {
        status: update.status,
        resolutionSummary: update.resolutionSummary,
      },
      now: new Date().toISOString(),
    });

    const severityChanged =
      update.severity !== undefined && update.severity !== row.severity;

    await client.query(
      `UPDATE investigations
       SET title = $3,
           description = $4,
           severity = $5,
           service = $6,
           error_signature = $7,
           window_start = $8,
           window_end = $9,
           source_types = $10::text[],
           status = $11,
           resolution_summary = $12,
           resolved_at = $13,
           closed_at = $14,
           updated_at = NOW()
       WHERE id = $1 AND organization_id = $2`,
      [
        investigationId,
        input.organizationId,
        title,
        description,
        severity,
        service,
        errorSignature,
        windowStart,
        windowEnd,
        sourceTypes,
        lifecycle.state.status,
        lifecycle.state.resolutionSummary,
        lifecycle.state.resolvedAt,
        lifecycle.state.closedAt,
      ]
    );

    if (lifecycle.changed && lifecycle.state.status !== currentStatus) {
      await insertActivity(client, {
        investigationId,
        organizationId: input.organizationId,
        type: "status_change",
        actorUserId: input.userId,
        body: `Status changed from ${currentStatus} to ${lifecycle.state.status}`,
        metadata: {
          from: currentStatus,
          to: lifecycle.state.status,
          // Kept in history instead of disappearing when a reopen clears it.
          previousResolutionSummary: lifecycle.previousResolutionSummary,
        },
      });
    }

    if (severityChanged) {
      await insertActivity(client, {
        investigationId,
        organizationId: input.organizationId,
        type: "severity_change",
        actorUserId: input.userId,
        body: `Severity changed from ${row.severity} to ${severity}`,
        metadata: { from: row.severity, to: severity },
      });
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  logger.info("investigation.updated", {
    organizationId: input.organizationId,
    investigationId,
    userId: input.userId,
    status: update.status ?? null,
  });

  return getInvestigationDetail(input.organizationId, investigationId);
}

export async function addInvestigationNote(input: {
  organizationId: string;
  investigationId: string;
  userId: string;
  payload: unknown;
}): Promise<InvestigationActivity> {
  const investigationId = normalizeInvestigationId(input.investigationId);
  const body = validateNoteBody(input.payload);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const exists = await client.query(
      `SELECT 1 FROM investigations
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE`,
      [investigationId, input.organizationId]
    );

    if (exists.rowCount === 0) {
      throw new InvestigationNotFoundError();
    }

    const activity = await insertActivity(client, {
      investigationId,
      organizationId: input.organizationId,
      type: "note",
      actorUserId: input.userId,
      body,
      metadata: null,
    });

    // A note is activity on the investigation, so the list ordering reflects it.
    await client.query(
      `UPDATE investigations SET updated_at = NOW()
       WHERE id = $1 AND organization_id = $2`,
      [investigationId, input.organizationId]
    );

    await client.query("COMMIT");

    return activity;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
