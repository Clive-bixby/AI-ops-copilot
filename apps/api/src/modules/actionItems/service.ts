import type { PoolClient } from "pg";

import { pool } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import {
  InvestigationConflictError,
  InvestigationNotFoundError,
  InvestigationValidationError,
} from "../investigations/errors.js";
import { normalizeInvestigationId } from "../investigations/policy.js";
import { assertOrganizationMember } from "../organization/organization.service.js";
import {
  applyActionItemStatusChange,
  normalizeActionItemId,
  validateCreateActionItem,
  validateListActionItemsQuery,
  validateUpdateActionItem,
} from "./policy.js";
import type {
  ActionItemCreatedFrom,
  ActionItemPriority,
  ActionItemStatus,
} from "./policy.js";
import type {
  ActionItem,
  ActionItemDetail,
  ActionItemEvent,
  ActionItemEventType,
  ActionItemList,
  ActionItemSummary,
} from "./types.js";

export type ActionItemRow = {
  id: string;
  organization_id: string;
  investigation_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee_user_id: string | null;
  assignee_email: string | null;
  due_at: Date | string | null;
  blocked_reason: string | null;
  completed_at: Date | string | null;
  completed_by: string | null;
  completed_by_email: string | null;
  created_from: string;
  source_analysis_id: string | null;
  source_hypothesis_id: string | null;
  source_label: string | null;
  created_by: string;
  created_by_email: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type ActionItemEventRow = {
  id: string;
  type: string;
  actor_user_id: string | null;
  actor_email: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
};

type SummaryRow = {
  total: number | string;
  open_count: number | string;
  in_progress_count: number | string;
  blocked_count: number | string;
  completed_count: number | string;
  overdue_count: number | string;
};

export const ACTION_ITEM_SELECT = `
  SELECT
    ai.id,
    ai.organization_id,
    ai.investigation_id,
    ai.title,
    ai.description,
    ai.status,
    ai.priority,
    ai.assignee_user_id,
    assignee.email AS assignee_email,
    ai.due_at,
    ai.blocked_reason,
    ai.completed_at,
    ai.completed_by,
    completer.email AS completed_by_email,
    ai.created_from,
    ai.source_analysis_id,
    ai.source_hypothesis_id,
    ai.source_label,
    ai.created_by,
    creator.email AS created_by_email,
    ai.created_at,
    ai.updated_at
  FROM action_items ai
  LEFT JOIN users assignee ON assignee.id = ai.assignee_user_id
  LEFT JOIN users creator ON creator.id = ai.created_by
  LEFT JOIN users completer ON completer.id = ai.completed_by
`;

function toIso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function mapActionItem(row: ActionItemRow): ActionItem {
  return {
    id: row.id,
    organizationId: row.organization_id,
    investigationId: row.investigation_id,
    title: row.title,
    description: row.description,
    status: row.status as ActionItemStatus,
    priority: row.priority as ActionItemPriority,
    assigneeUserId: row.assignee_user_id,
    assigneeEmail: row.assignee_email,
    dueAt: toIso(row.due_at),
    blockedReason: row.blocked_reason,
    completedAt: toIso(row.completed_at),
    completedBy: row.completed_by,
    completedByEmail: row.completed_by_email,
    createdFrom: row.created_from as ActionItemCreatedFrom,
    sourceAnalysisId: row.source_analysis_id,
    sourceHypothesisId: row.source_hypothesis_id,
    sourceLabel: row.source_label,
    createdBy: row.created_by,
    createdByEmail: row.created_by_email,
    createdAt: toIso(row.created_at) ?? "",
    updatedAt: toIso(row.updated_at) ?? "",
  };
}

function mapEvent(row: ActionItemEventRow): ActionItemEvent {
  return {
    id: row.id,
    type: row.type as ActionItemEventType,
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    body: row.body,
    metadata: row.metadata,
    createdAt: toIso(row.created_at) ?? "",
  };
}

function mapSummary(row: SummaryRow | undefined): ActionItemSummary {
  return {
    total: Number(row?.total ?? 0),
    open: Number(row?.open_count ?? 0),
    inProgress: Number(row?.in_progress_count ?? 0),
    blocked: Number(row?.blocked_count ?? 0),
    completed: Number(row?.completed_count ?? 0),
    overdue: Number(row?.overdue_count ?? 0),
  };
}

/**
 * Append one event. Called inside the caller's transaction: history that
 * survived a rolled-back action-item change would describe something that never
 * happened.
 */
async function insertActionItemEvent(
  client: PoolClient,
  input: {
    actionItemId: string;
    organizationId: string;
    type: ActionItemEventType;
    actorUserId: string;
    body: string | null;
    metadata: Record<string, unknown> | null;
  }
): Promise<ActionItemEvent> {
  const result = await client.query<ActionItemEventRow>(
    `WITH inserted AS (
       INSERT INTO action_item_events (
         action_item_id, organization_id, type, actor_user_id, body, metadata
       )
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::jsonb, '{}'::jsonb))
       RETURNING id, type, actor_user_id, body, metadata, created_at
     )
     SELECT i.id, i.type, i.actor_user_id, u.email AS actor_email,
            i.body, i.metadata, i.created_at
     FROM inserted i
     LEFT JOIN users u ON u.id = i.actor_user_id`,
    [
      input.actionItemId,
      input.organizationId,
      input.type,
      input.actorUserId,
      input.body,
      input.metadata === null ? null : JSON.stringify(input.metadata),
    ]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Failed to record action item event");
  }

  return mapEvent(row);
}

async function loadActionItem(
  organizationId: string,
  investigationId: string,
  actionItemId: string
): Promise<ActionItemRow> {
  const result = await pool.query<ActionItemRow>(
    `${ACTION_ITEM_SELECT}
     WHERE ai.id = $1 AND ai.investigation_id = $2 AND ai.organization_id = $3`,
    [actionItemId, investigationId, organizationId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new InvestigationNotFoundError("Action item not found");
  }

  return row;
}

async function listEvents(
  organizationId: string,
  investigationId: string,
  actionItemId: string
): Promise<ActionItemEvent[]> {
  const result = await pool.query<ActionItemEventRow>(
    `SELECT
       e.id,
       e.type,
       e.actor_user_id,
       u.email AS actor_email,
       e.body,
       e.metadata,
       e.created_at
     FROM action_item_events e
     JOIN action_items ai
       ON ai.id = e.action_item_id
      AND ai.organization_id = e.organization_id
     LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE e.action_item_id = $1
       AND e.organization_id = $2
       AND ai.investigation_id = $3
     ORDER BY e.created_at ASC, e.id ASC`,
    [actionItemId, organizationId, investigationId]
  );

  return result.rows.map(mapEvent);
}

export async function getActionItemDetail(input: {
  organizationId: string;
  investigationId: string;
  actionItemId: string;
}): Promise<ActionItemDetail> {
  const investigationId = normalizeInvestigationId(input.investigationId);
  const actionItemId = normalizeActionItemId(input.actionItemId);

  const [row, events] = await Promise.all([
    loadActionItem(input.organizationId, investigationId, actionItemId),
    listEvents(input.organizationId, investigationId, actionItemId),
  ]);

  return { item: mapActionItem(row), events };
}

export async function listActionItems(input: {
  organizationId: string;
  investigationId: string;
  userId: string;
  query: unknown;
}): Promise<ActionItemList> {
  const investigationId = normalizeInvestigationId(input.investigationId);
  const filters = validateListActionItemsQuery(input.query);

  const investigation = await pool.query<{ status: string }>(
    `SELECT status FROM investigations WHERE id = $1 AND organization_id = $2`,
    [investigationId, input.organizationId]
  );

  if (!investigation.rows[0]) {
    throw new InvestigationNotFoundError();
  }

  // `me` is resolved here so the policy stays free of request context.
  let assigneeUserId: string | null = null;
  let unassignedOnly = false;

  if (filters.assignee?.kind === "me") {
    assigneeUserId = input.userId;
  } else if (filters.assignee?.kind === "unassigned") {
    unassignedOnly = true;
  } else if (filters.assignee?.kind === "user") {
    assigneeUserId = filters.assignee.userId;
  }

  const [items, summary] = await Promise.all([
    pool.query<ActionItemRow>(
      `${ACTION_ITEM_SELECT}
       WHERE ai.investigation_id = $1
         AND ai.organization_id = $2
         AND ($3::text IS NULL OR ai.status = $3)
         AND ($4::text IS NULL OR ai.priority = $4)
         AND ($5::uuid IS NULL OR ai.assignee_user_id = $5)
         AND ($6::boolean = FALSE OR ai.assignee_user_id IS NULL)
       ORDER BY
         CASE ai.status
           WHEN 'open' THEN 0
           WHEN 'in_progress' THEN 1
           WHEN 'blocked' THEN 2
           ELSE 3
         END,
         CASE ai.priority
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'medium' THEN 2
           ELSE 3
         END,
         ai.due_at ASC NULLS LAST,
         ai.created_at ASC
       LIMIT $7 OFFSET $8`,
      [
        investigationId,
        input.organizationId,
        filters.status ?? null,
        filters.priority ?? null,
        assigneeUserId,
        unassignedOnly,
        filters.limit,
        filters.offset,
      ]
    ),
    pool.query<SummaryRow>(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'open') AS open_count,
         COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress_count,
         COUNT(*) FILTER (WHERE status = 'blocked') AS blocked_count,
         COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
         COUNT(*) FILTER (
           WHERE status <> 'completed'
             AND due_at IS NOT NULL
             AND due_at < NOW()
         ) AS overdue_count
       FROM action_items
       WHERE investigation_id = $1 AND organization_id = $2`,
      [investigationId, input.organizationId]
    ),
  ]);

  return {
    items: items.rows.map(mapActionItem),
    summary: mapSummary(summary.rows[0]),
    limit: filters.limit,
    offset: filters.offset,
  };
}

export async function createActionItem(input: {
  organizationId: string;
  investigationId: string;
  userId: string;
  payload: unknown;
}): Promise<ActionItemDetail> {
  const investigationId = normalizeInvestigationId(input.investigationId);
  const parsed = validateCreateActionItem(input.payload);

  // Validate before the transaction so a bad assignee does not leave a
  // half-written item behind. The composite foreign key is the backstop.
  if (parsed.assigneeUserId !== null) {
    await assertOrganizationMember(input.organizationId, parsed.assigneeUserId);
  }

  const client = await pool.connect();
  let actionItemId: string | null = null;

  try {
    await client.query("BEGIN");

    // Lock the investigation so a concurrent close cannot race a new item in
    // after the record became read-only.
    const investigation = await client.query<{ status: string }>(
      `SELECT status FROM investigations
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE`,
      [investigationId, input.organizationId]
    );

    const investigationRow = investigation.rows[0];
    if (!investigationRow) {
      throw new InvestigationNotFoundError();
    }

    if (investigationRow.status === "closed") {
      throw new InvestigationConflictError(
        "A closed investigation cannot receive new action items"
      );
    }

    // Provenance points at rows in this investigation, not merely in this
    // organization.
    if (parsed.sourceAnalysisId !== null) {
      const source = await client.query(
        `SELECT 1 FROM investigation_analyses
         WHERE id = $1 AND investigation_id = $2`,
        [parsed.sourceAnalysisId, investigationId]
      );

      if (source.rowCount === 0) {
        throw new InvestigationValidationError(
          "The source analysis does not belong to this investigation"
        );
      }
    }

    if (parsed.sourceHypothesisId !== null) {
      const source = await client.query(
        `SELECT 1 FROM investigation_hypotheses
         WHERE id = $1 AND investigation_id = $2`,
        [parsed.sourceHypothesisId, investigationId]
      );

      if (source.rowCount === 0) {
        throw new InvestigationValidationError(
          "The source hypothesis does not belong to this investigation"
        );
      }
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO action_items (
         organization_id, investigation_id, title, description, status, priority,
         assignee_user_id, due_at, created_from, source_analysis_id,
         source_hypothesis_id, source_label, created_by
       )
       VALUES (
         $1, $2, $3, $4, 'open', $5, $6, $7, $8, $9, $10, $11, $12
       )
       RETURNING id`,
      [
        input.organizationId,
        investigationId,
        parsed.title,
        parsed.description,
        parsed.priority,
        parsed.assigneeUserId,
        parsed.dueAt,
        parsed.createdFrom,
        parsed.sourceAnalysisId,
        parsed.sourceHypothesisId,
        parsed.sourceLabel,
        input.userId,
      ]
    );

    const row = inserted.rows[0];
    if (!row) {
      throw new Error("Failed to create action item");
    }

    actionItemId = row.id;

    await insertActionItemEvent(client, {
      actionItemId: row.id,
      organizationId: input.organizationId,
      type: "created",
      actorUserId: input.userId,
      body: "Action item created",
      metadata: {
        status: "open",
        priority: parsed.priority,
        assigneeUserId: parsed.assigneeUserId,
        dueAt: parsed.dueAt,
        createdFrom: parsed.createdFrom,
        sourceLabel: parsed.sourceLabel,
      },
    });

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (actionItemId === null) {
    throw new Error("Failed to create action item");
  }

  logger.info("action_item.created", {
    organizationId: input.organizationId,
    investigationId,
    actionItemId,
    userId: input.userId,
    priority: parsed.priority,
    createdFrom: parsed.createdFrom,
  });

  return getActionItemDetail({
    organizationId: input.organizationId,
    investigationId,
    actionItemId,
  });
}

export async function updateActionItem(input: {
  organizationId: string;
  investigationId: string;
  actionItemId: string;
  userId: string;
  payload: unknown;
}): Promise<ActionItemDetail> {
  const investigationId = normalizeInvestigationId(input.investigationId);
  const actionItemId = normalizeActionItemId(input.actionItemId);
  const update = validateUpdateActionItem(input.payload);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Lock the item so concurrent PATCH requests serialize and the optimistic
    // concurrency check cannot pass on stale state.
    const current = await client.query<ActionItemRow>(
      `${ACTION_ITEM_SELECT}
       WHERE ai.id = $1 AND ai.investigation_id = $2 AND ai.organization_id = $3
       FOR UPDATE OF ai`,
      [actionItemId, investigationId, input.organizationId]
    );

    const row = current.rows[0];
    if (!row) {
      throw new InvestigationNotFoundError("Action item not found");
    }

    if (update.expectedUpdatedAt !== undefined) {
      const expected = new Date(update.expectedUpdatedAt).getTime();
      const actual = new Date(row.updated_at).getTime();

      if (expected !== actual) {
        throw new InvestigationConflictError(
          "The action item changed since it was loaded; reload it and retry"
        );
      }
    }

    const currentStatus = row.status as ActionItemStatus;
    const lifecycle = applyActionItemStatusChange({
      current: {
        status: currentStatus,
        blockedReason: row.blocked_reason,
        completedAt: toIso(row.completed_at),
        completedBy: row.completed_by,
      },
      request: {
        status: update.status,
        blockedReason: update.blockedReason,
      },
      now: new Date().toISOString(),
      actorUserId: input.userId,
    });

    const title = update.title ?? row.title;
    const description =
      update.description === undefined ? row.description : update.description;
    const priority = (update.priority ?? row.priority) as ActionItemPriority;
    const assigneeUserId =
      update.assigneeUserId === undefined
        ? row.assignee_user_id
        : update.assigneeUserId;
    const dueAt =
      update.dueAt === undefined ? toIso(row.due_at) : update.dueAt;

    const assigneeChanged =
      update.assigneeUserId !== undefined &&
      update.assigneeUserId !== row.assignee_user_id;

    let assigneeEmail = row.assignee_email;

    if (assigneeChanged) {
      if (assigneeUserId === null) {
        assigneeEmail = null;
      } else {
        assigneeEmail = (
          await assertOrganizationMember(input.organizationId, assigneeUserId)
        ).email;
      }
    }

    const priorityChanged =
      update.priority !== undefined && update.priority !== row.priority;
    const dueChanged =
      update.dueAt !== undefined && dueAt !== toIso(row.due_at);
    const titleChanged = update.title !== undefined && title !== row.title;
    const descriptionChanged =
      update.description !== undefined && description !== row.description;
    const statusChanged = lifecycle.state.status !== currentStatus;
    const blockedReasonChanged =
      lifecycle.state.blockedReason !== row.blocked_reason;

    await client.query(
      `UPDATE action_items
       SET title = $4,
           description = $5,
           priority = $6,
           assignee_user_id = $7,
           due_at = $8,
           status = $9,
           blocked_reason = $10,
           completed_at = $11,
           completed_by = $12,
           updated_at = NOW()
       WHERE id = $1 AND investigation_id = $2 AND organization_id = $3`,
      [
        actionItemId,
        investigationId,
        input.organizationId,
        title,
        description,
        priority,
        assigneeUserId,
        dueAt,
        lifecycle.state.status,
        lifecycle.state.blockedReason,
        lifecycle.state.completedAt,
        lifecycle.state.completedBy,
      ]
    );

    if (statusChanged) {
      await insertActionItemEvent(client, {
        actionItemId,
        organizationId: input.organizationId,
        type: "status_change",
        actorUserId: input.userId,
        body: `Status changed from ${currentStatus} to ${lifecycle.state.status}`,
        metadata: {
          from: currentStatus,
          to: lifecycle.state.status,
          // Kept in history instead of disappearing when the reason is cleared.
          previousBlockedReason: lifecycle.previousBlockedReason,
          blockedReason: lifecycle.state.blockedReason,
          completedAt: lifecycle.state.completedAt,
          completedBy: lifecycle.state.completedBy,
        },
      });
    } else if (blockedReasonChanged) {
      await insertActionItemEvent(client, {
        actionItemId,
        organizationId: input.organizationId,
        type: "details_change",
        actorUserId: input.userId,
        body: "Blocked reason updated",
        metadata: {
          fields: ["blockedReason"],
          from: row.blocked_reason,
          to: lifecycle.state.blockedReason,
        },
      });
    }

    if (assigneeChanged) {
      await insertActionItemEvent(client, {
        actionItemId,
        organizationId: input.organizationId,
        type: "assignee_change",
        actorUserId: input.userId,
        body:
          assigneeUserId === null
            ? "Action item unassigned"
            : row.assignee_user_id === null
              ? `Assigned to ${assigneeEmail ?? assigneeUserId}`
              : `Reassigned to ${assigneeEmail ?? assigneeUserId}`,
        metadata: {
          fromUserId: row.assignee_user_id,
          fromEmail: row.assignee_email,
          toUserId: assigneeUserId,
          toEmail: assigneeEmail,
        },
      });
    }

    if (priorityChanged) {
      await insertActionItemEvent(client, {
        actionItemId,
        organizationId: input.organizationId,
        type: "priority_change",
        actorUserId: input.userId,
        body: `Priority changed from ${row.priority} to ${priority}`,
        metadata: { from: row.priority, to: priority },
      });
    }

    if (dueChanged) {
      await insertActionItemEvent(client, {
        actionItemId,
        organizationId: input.organizationId,
        type: "due_change",
        actorUserId: input.userId,
        body:
          dueAt === null
            ? "Due date cleared"
            : `Due date set to ${dueAt}`,
        metadata: { from: toIso(row.due_at), to: dueAt },
      });
    }

    if (titleChanged || descriptionChanged) {
      const fields: string[] = [];
      if (titleChanged) fields.push("title");
      if (descriptionChanged) fields.push("description");

      await insertActionItemEvent(client, {
        actionItemId,
        organizationId: input.organizationId,
        type: "details_change",
        actorUserId: input.userId,
        body: "Action item details updated",
        metadata: { fields },
      });
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  logger.info("action_item.updated", {
    organizationId: input.organizationId,
    investigationId,
    actionItemId,
    userId: input.userId,
    status: update.status ?? null,
  });

  return getActionItemDetail({
    organizationId: input.organizationId,
    investigationId,
    actionItemId,
  });
}
