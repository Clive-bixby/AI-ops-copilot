import {
  ACTION_ITEM_LIMITS,
  ACTION_ITEM_PRIORITIES,
  ACTION_ITEM_STATUSES,
} from "../actionItems/policy.js";
import type {
  ActionItemPriority,
  ActionItemStatus,
} from "../actionItems/policy.js";
import { InvestigationValidationError } from "../investigations/errors.js";
import {
  UUID_PATTERN,
  isRecord,
  readBoundedInteger,
  readEnum,
  readQueryValue,
} from "../investigations/policy.js";

/**
 * Validation for the operational overview and the cross-investigation action
 * item queue.
 *
 * Nothing here touches the database, so the accepted filters (and the exact
 * definition of "overdue" and "due soon") are testable without Postgres and are
 * not silently re-derived by the frontend.
 */

/**
 * An action item is "due soon" when it is unfinished and due within this window.
 * Kept small enough to be a genuine heads-up rather than a second backlog.
 */
export const OPERATIONS_DUE_SOON_HOURS = 48;

export const OPERATIONS_LIMITS = {
  /** Recently updated / resolved / completed entries per overview list. */
  recentMax: 5,
  listDefaultLimit: 25,
  listMaxLimit: 100,
  listMaxOffset: 10_000,
} as const;

export type OperationsDueFilter = "overdue" | "due_soon";

export type OperationsAssigneeFilter =
  | { kind: "me" }
  | { kind: "unassigned" }
  | { kind: "user"; userId: string };

export type OperationsActionItemQuery = {
  status?: ActionItemStatus;
  priority?: ActionItemPriority;
  assignee?: OperationsAssigneeFilter;
  due?: OperationsDueFilter;
  investigationId?: string;
  limit: number;
  offset: number;
};

function parseAssignee(value: string): OperationsAssigneeFilter {
  if (value === "me") {
    return { kind: "me" };
  }

  if (value === "unassigned") {
    return { kind: "unassigned" };
  }

  if (UUID_PATTERN.test(value)) {
    return { kind: "user", userId: value };
  }

  throw new InvestigationValidationError(
    "assignee must be 'me', 'unassigned' or a user id"
  );
}

export function validateOperationsActionItemQuery(
  query: unknown
): OperationsActionItemQuery {
  const record = isRecord(query) ? query : {};
  const result: OperationsActionItemQuery = {
    limit: OPERATIONS_LIMITS.listDefaultLimit,
    offset: 0,
  };

  const status = readQueryValue(record.status, "status");
  if (status !== undefined && status !== "") {
    result.status = readEnum(status, "status", ACTION_ITEM_STATUSES);
  }

  const priority = readQueryValue(record.priority, "priority");
  if (priority !== undefined && priority !== "") {
    result.priority = readEnum(priority, "priority", ACTION_ITEM_PRIORITIES);
  }

  const assignee = readQueryValue(record.assignee, "assignee");
  if (assignee !== undefined && assignee.trim() !== "") {
    result.assignee = parseAssignee(assignee.trim());
  }

  const due = readQueryValue(record.due, "due");
  if (due !== undefined && due !== "") {
    result.due = readEnum(due, "due", ["overdue", "due_soon"] as const);
  }

  const investigationId = readQueryValue(record.investigationId, "investigationId");
  if (investigationId !== undefined && investigationId.trim() !== "") {
    if (!UUID_PATTERN.test(investigationId.trim())) {
      throw new InvestigationValidationError(
        "investigationId must be a valid id"
      );
    }
    result.investigationId = investigationId.trim();
  }

  const limit = readQueryValue(record.limit, "limit");
  if (limit !== undefined && limit !== "") {
    result.limit = readBoundedInteger(
      limit,
      "limit",
      1,
      OPERATIONS_LIMITS.listMaxLimit
    );
  }

  const offset = readQueryValue(record.offset, "offset");
  if (offset !== undefined && offset !== "") {
    result.offset = readBoundedInteger(
      offset,
      "offset",
      0,
      OPERATIONS_LIMITS.listMaxOffset
    );
  }

  return result;
}

/**
 * `ACTION_ITEM_LIMITS` is imported so the queue and the per-investigation list
 * accept the same defaults; this keeps the two ceilings from drifting apart.
 */
export const OPERATIONS_SHARED_LIST_DEFAULT =
  ACTION_ITEM_LIMITS.listDefaultLimit;
