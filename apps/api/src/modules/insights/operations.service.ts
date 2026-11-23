import { pool } from "../../core/db.js";
import { mapActionItem } from "../actionItems/service.js";
import type { ActionItemRow } from "../actionItems/service.js";
import type { ActionItemSummary } from "../actionItems/types.js";
import type {
  ActionItemPriority,
  ActionItemStatus,
} from "../actionItems/policy.js";
import type {
  InvestigationSeverity,
  InvestigationStatus,
} from "../investigations/policy.js";
import {
  OPERATIONS_DUE_SOON_HOURS,
  OPERATIONS_LIMITS,
  validateOperationsActionItemQuery,
} from "./operations.policy.js";

/**
 * Operational overview and the cross-investigation action-item queue.
 *
 * Every number is counted by Postgres over rows scoped to one organization. The
 * web client never recomputes a metric from a page of results, so a count cannot
 * disagree with the list it links to and an unfiltered total is never mistaken
 * for a filtered one.
 */

export type OperationsInvestigationRef = {
  id: string;
  title: string;
  status: InvestigationStatus;
  severity: InvestigationSeverity;
  ownerUserId: string | null;
  ownerEmail: string | null;
  updatedAt: string;
  resolvedAt: string | null;
};

export type OperationsActionItemRef = {
  id: string;
  title: string;
  status: ActionItemStatus;
  priority: ActionItemPriority;
  assigneeUserId: string | null;
  assigneeEmail: string | null;
  dueAt: string | null;
  investigationId: string;
  investigationTitle: string;
  completedAt: string | null;
  updatedAt: string;
};

export type OperationsActionItem = ReturnType<typeof mapActionItem> & {
  investigationTitle: string;
};

export type OperationsActionItemSummary = ActionItemSummary & {
  /** Unfinished and due within OPERATIONS_DUE_SOON_HOURS. */
  dueSoon: number;
  assignedToMe: number;
  unassigned: number;
};

export type OperationsOverview = {
  dueSoonHours: number;
  investigations: {
    total: number;
    open: number;
    investigating: number;
    resolved: number;
    closed: number;
    assignedToMe: number;
    unassigned: number;
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
    recentlyUpdated: OperationsInvestigationRef[];
    recentlyResolved: OperationsInvestigationRef[];
  };
  actionItems: {
    summary: OperationsActionItemSummary;
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
    recentlyCompleted: OperationsActionItemRef[];
  };
};

export type OperationsActionItemList = {
  items: OperationsActionItem[];
  /** Organization-wide totals, independent of the active filters. */
  summary: OperationsActionItemSummary;
  /** Number of items matching the filters, used for pagination. */
  total: number;
  limit: number;
  offset: number;
};

type CountRow = { key: string; count: number };

type InvestigationRefRow = {
  id: string;
  title: string;
  status: string;
  severity: string;
  owner_user_id: string | null;
  owner_email: string | null;
  updated_at: Date | string;
  resolved_at: Date | string | null;
};

type ActionItemRefRow = {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee_user_id: string | null;
  assignee_email: string | null;
  due_at: Date | string | null;
  investigation_id: string;
  investigation_title: string;
  completed_at: Date | string | null;
  updated_at: Date | string;
};

type ActionItemSummaryRow = {
  total: number | string;
  open_count: number | string;
  in_progress_count: number | string;
  blocked_count: number | string;
  completed_count: number | string;
  overdue_count: number | string;
  due_soon_count: number | string;
  assigned_to_me_count: number | string;
  unassigned_count: number | string;
};

/**
 * Fields the queue adds to the shared action-item projection so a row can name
 * the investigation it belongs to.
 */
const OPERATIONS_ACTION_ITEM_SELECT = `
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
    ai.updated_at,
    inv.title AS investigation_title
  FROM action_items ai
  JOIN investigations inv
    ON inv.id = ai.investigation_id
   AND inv.organization_id = ai.organization_id
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

function toCountMap(rows: CountRow[], keys: readonly string[] = []): Record<string, number> {
  const map = Object.fromEntries(keys.map((key) => [key, 0])) as Record<
    string,
    number
  >;

  for (const row of rows) {
    map[row.key] = Number(row.count);
  }

  return map;
}

function mapInvestigationRef(row: InvestigationRefRow): OperationsInvestigationRef {
  return {
    id: row.id,
    title: row.title,
    status: row.status as InvestigationStatus,
    severity: row.severity as InvestigationSeverity,
    ownerUserId: row.owner_user_id,
    ownerEmail: row.owner_email,
    updatedAt: toIso(row.updated_at) ?? "",
    resolvedAt: toIso(row.resolved_at),
  };
}

function mapActionItemRef(row: ActionItemRefRow): OperationsActionItemRef {
  return {
    id: row.id,
    title: row.title,
    status: row.status as ActionItemStatus,
    priority: row.priority as ActionItemPriority,
    assigneeUserId: row.assignee_user_id,
    assigneeEmail: row.assignee_email,
    dueAt: toIso(row.due_at),
    investigationId: row.investigation_id,
    investigationTitle: row.investigation_title,
    completedAt: toIso(row.completed_at),
    updatedAt: toIso(row.updated_at) ?? "",
  };
}

function mapSummary(row: ActionItemSummaryRow | undefined): OperationsActionItemSummary {
  return {
    total: Number(row?.total ?? 0),
    open: Number(row?.open_count ?? 0),
    inProgress: Number(row?.in_progress_count ?? 0),
    blocked: Number(row?.blocked_count ?? 0),
    completed: Number(row?.completed_count ?? 0),
    overdue: Number(row?.overdue_count ?? 0),
    dueSoon: Number(row?.due_soon_count ?? 0),
    assignedToMe: Number(row?.assigned_to_me_count ?? 0),
    unassigned: Number(row?.unassigned_count ?? 0),
  };
}

/** The summary is always organization-wide; only the queue query is filtered. */
async function loadActionItemSummary(
  organizationId: string,
  userId: string
): Promise<OperationsActionItemSummary> {
  const result = await pool.query<ActionItemSummaryRow>(
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
       ) AS overdue_count,
       COUNT(*) FILTER (
         WHERE status <> 'completed'
           AND due_at IS NOT NULL
           AND due_at >= NOW()
           AND due_at <= NOW() + ($3::int * INTERVAL '1 hour')
       ) AS due_soon_count,
       COUNT(*) FILTER (WHERE assignee_user_id = $2) AS assigned_to_me_count,
       COUNT(*) FILTER (WHERE assignee_user_id IS NULL) AS unassigned_count
     FROM action_items
     WHERE organization_id = $1`,
    [organizationId, userId, OPERATIONS_DUE_SOON_HOURS]
  );

  return mapSummary(result.rows[0]);
}

export async function getOperationsOverview(input: {
  organizationId: string;
  userId: string;
}): Promise<OperationsOverview> {
  const { organizationId, userId } = input;

  const [
    investigationCounts,
    investigationStatuses,
    investigationSeverities,
    recentlyUpdated,
    recentlyResolved,
    actionSummary,
    actionStatuses,
    actionPriorities,
    recentlyCompleted,
  ] = await Promise.all([
    pool.query<{
      total: number;
      open: number;
      investigating: number;
      resolved: number;
      closed: number;
      assigned_to_me: number;
      unassigned: number;
    }>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'open')::int AS open,
         COUNT(*) FILTER (WHERE status = 'investigating')::int AS investigating,
         COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved,
         COUNT(*) FILTER (WHERE status = 'closed')::int AS closed,
         COUNT(*) FILTER (WHERE owner_user_id = $2)::int AS assigned_to_me,
         COUNT(*) FILTER (WHERE owner_user_id IS NULL)::int AS unassigned
       FROM investigations
       WHERE organization_id = $1`,
      [organizationId, userId]
    ),
    pool.query<CountRow>(
      `SELECT status AS key, COUNT(*)::int AS count
       FROM investigations
       WHERE organization_id = $1
       GROUP BY 1`,
      [organizationId]
    ),
    pool.query<CountRow>(
      `SELECT severity AS key, COUNT(*)::int AS count
       FROM investigations
       WHERE organization_id = $1
       GROUP BY 1`,
      [organizationId]
    ),
    pool.query<InvestigationRefRow>(
      `SELECT
         i.id, i.title, i.status, i.severity,
         i.owner_user_id, u.email AS owner_email,
         i.updated_at, i.resolved_at
       FROM investigations i
       LEFT JOIN users u ON u.id = i.owner_user_id
       WHERE i.organization_id = $1
       ORDER BY i.updated_at DESC, i.id DESC
       LIMIT $2`,
      [organizationId, OPERATIONS_LIMITS.recentMax]
    ),
    pool.query<InvestigationRefRow>(
      `SELECT
         i.id, i.title, i.status, i.severity,
         i.owner_user_id, u.email AS owner_email,
         i.updated_at, i.resolved_at
       FROM investigations i
       LEFT JOIN users u ON u.id = i.owner_user_id
       WHERE i.organization_id = $1 AND i.status = 'resolved'
       ORDER BY i.resolved_at DESC NULLS LAST, i.id DESC
       LIMIT $2`,
      [organizationId, OPERATIONS_LIMITS.recentMax]
    ),
    loadActionItemSummary(organizationId, userId),
    pool.query<CountRow>(
      `SELECT status AS key, COUNT(*)::int AS count
       FROM action_items
       WHERE organization_id = $1
       GROUP BY 1`,
      [organizationId]
    ),
    pool.query<CountRow>(
      `SELECT priority AS key, COUNT(*)::int AS count
       FROM action_items
       WHERE organization_id = $1
       GROUP BY 1`,
      [organizationId]
    ),
    pool.query<ActionItemRefRow>(
      `SELECT
         ai.id, ai.title, ai.status, ai.priority,
         ai.assignee_user_id, u.email AS assignee_email,
         ai.due_at, ai.investigation_id, inv.title AS investigation_title,
         ai.completed_at, ai.updated_at
       FROM action_items ai
       JOIN investigations inv
         ON inv.id = ai.investigation_id
        AND inv.organization_id = ai.organization_id
       LEFT JOIN users u ON u.id = ai.assignee_user_id
       WHERE ai.organization_id = $1 AND ai.status = 'completed'
       ORDER BY ai.completed_at DESC NULLS LAST, ai.id DESC
       LIMIT $2`,
      [organizationId, OPERATIONS_LIMITS.recentMax]
    ),
  ]);

  const counts = investigationCounts.rows[0];

  return {
    dueSoonHours: OPERATIONS_DUE_SOON_HOURS,
    investigations: {
      total: Number(counts?.total ?? 0),
      open: Number(counts?.open ?? 0),
      investigating: Number(counts?.investigating ?? 0),
      resolved: Number(counts?.resolved ?? 0),
      closed: Number(counts?.closed ?? 0),
      assignedToMe: Number(counts?.assigned_to_me ?? 0),
      unassigned: Number(counts?.unassigned ?? 0),
      byStatus: toCountMap(investigationStatuses.rows, [
        "open",
        "investigating",
        "resolved",
        "closed",
      ]),
      bySeverity: toCountMap(investigationSeverities.rows, [
        "low",
        "medium",
        "high",
        "critical",
      ]),
      recentlyUpdated: recentlyUpdated.rows.map(mapInvestigationRef),
      recentlyResolved: recentlyResolved.rows.map(mapInvestigationRef),
    },
    actionItems: {
      summary: actionSummary,
      byStatus: toCountMap(actionStatuses.rows, [
        "open",
        "in_progress",
        "blocked",
        "completed",
      ]),
      byPriority: toCountMap(actionPriorities.rows, [
        "low",
        "medium",
        "high",
        "critical",
      ]),
      recentlyCompleted: recentlyCompleted.rows.map(mapActionItemRef),
    },
  };
}

export async function listOperationsActionItems(input: {
  organizationId: string;
  userId: string;
  query: unknown;
}): Promise<OperationsActionItemList> {
  const filters = validateOperationsActionItemQuery(input.query);

  let assigneeUserId: string | null = null;
  let unassignedOnly = false;

  if (filters.assignee?.kind === "me") {
    assigneeUserId = input.userId;
  } else if (filters.assignee?.kind === "unassigned") {
    unassignedOnly = true;
  } else if (filters.assignee?.kind === "user") {
    assigneeUserId = filters.assignee.userId;
  }

  const due = filters.due ?? null;
  const investigationId = filters.investigationId ?? null;

  const where = `
    WHERE ai.organization_id = $1
      AND ($2::text IS NULL OR ai.status = $2)
      AND ($3::text IS NULL OR ai.priority = $3)
      AND ($4::uuid IS NULL OR ai.assignee_user_id = $4)
      AND ($5::boolean = FALSE OR ai.assignee_user_id IS NULL)
      AND ($6::uuid IS NULL OR ai.investigation_id = $6)
      AND (
        $7::text IS NULL
        OR (
          $7 = 'overdue'
          AND ai.status <> 'completed'
          AND ai.due_at IS NOT NULL
          AND ai.due_at < NOW()
        )
        OR (
          $7 = 'due_soon'
          AND ai.status <> 'completed'
          AND ai.due_at IS NOT NULL
          AND ai.due_at >= NOW()
          AND ai.due_at <= NOW() + ($8::int * INTERVAL '1 hour')
        )
      )
  `;

  const params = [
    input.organizationId,
    filters.status ?? null,
    filters.priority ?? null,
    assigneeUserId,
    unassignedOnly,
    investigationId,
    due,
    OPERATIONS_DUE_SOON_HOURS,
  ];

  const [items, count, summary] = await Promise.all([
    pool.query<ActionItemRow & { investigation_title: string }>(
      `${OPERATIONS_ACTION_ITEM_SELECT}
       ${where}
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
         ai.created_at ASC,
         ai.id ASC
       LIMIT $9 OFFSET $10`,
      [...params, filters.limit, filters.offset]
    ),
    pool.query<{ total: number | string }>(
      `SELECT COUNT(*) AS total
       FROM action_items ai
       ${where}`,
      params
    ),
    loadActionItemSummary(input.organizationId, input.userId),
  ]);

  return {
    items: items.rows.map((row) => ({
      ...mapActionItem(row),
      investigationTitle: row.investigation_title,
    })),
    summary,
    total: Number(count.rows[0]?.total ?? 0),
    limit: filters.limit,
    offset: filters.offset,
  };
}

