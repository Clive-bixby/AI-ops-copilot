import {
  InvestigationConflictError,
  InvestigationNotFoundError,
  InvestigationValidationError,
} from "../investigations/errors.js";
import {
  UUID_PATTERN,
  hasKey,
  isRecord,
  readBoundedInteger,
  readEnum,
  readOptionalText,
  readOptionalTimestamp,
  readOptionalUuid,
  readQueryValue,
  readRequiredString,
  readRequiredTimestamp,
  requireRecord,
} from "../investigations/policy.js";

/**
 * Validation and lifecycle rules for action items.
 *
 * Like the investigation policy, this file never touches the database. The
 * provenance and lifecycle rules are mirrored by CHECK constraints and a trigger
 * in `0008_action_items.sql`; the policy exists so a client gets a typed error
 * before a transaction is opened, and so the rules are testable without Postgres.
 */

export const ACTION_ITEM_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "completed",
] as const;

export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];

export const ACTION_ITEM_PRIORITIES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;

export type ActionItemPriority = (typeof ACTION_ITEM_PRIORITIES)[number];

export const ACTION_ITEM_CREATED_FROM = ["manual", "analysis"] as const;

export type ActionItemCreatedFrom = (typeof ACTION_ITEM_CREATED_FROM)[number];

export const ACTION_ITEM_LIMITS = {
  titleMin: 3,
  titleMax: 200,
  descriptionMax: 4000,
  blockedReasonMax: 1000,
  sourceLabelMin: 1,
  sourceLabelMax: 500,
  listDefaultLimit: 50,
  listMaxLimit: 100,
  listMaxOffset: 10_000,
} as const;

/**
 * A source id is optional and only meaningful for an analysis-derived item. The
 * format is checked here; the service verifies that the source belongs to the
 * same investigation.
 */
function readOptionalId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new InvestigationValidationError(`${label} must be a valid id`);
  }

  return value.trim();
}

export type CreateActionItemInput = {
  title: string;
  description: string | null;
  priority: ActionItemPriority;
  /** NULL means unassigned; never inferred from the creator. */
  assigneeUserId: string | null;
  dueAt: string | null;
  createdFrom: ActionItemCreatedFrom;
  sourceAnalysisId: string | null;
  sourceHypothesisId: string | null;
  sourceLabel: string | null;
};

export function validateCreateActionItem(
  payload: unknown
): CreateActionItemInput {
  const record = requireRecord(payload);

  const title = readRequiredString(
    record.title,
    "Title",
    ACTION_ITEM_LIMITS.titleMin,
    ACTION_ITEM_LIMITS.titleMax
  );
  const description = readOptionalText(
    record.description,
    "Description",
    ACTION_ITEM_LIMITS.descriptionMax
  );
  const priority =
    record.priority === undefined || record.priority === null
      ? "medium"
      : readEnum(record.priority, "Priority", ACTION_ITEM_PRIORITIES);
  const assigneeUserId = readOptionalUuid(
    record.assigneeUserId,
    "assigneeUserId"
  );
  const dueAt = readOptionalTimestamp(record.dueAt, "dueAt");
  const createdFrom =
    record.createdFrom === undefined || record.createdFrom === null
      ? "manual"
      : readEnum(
          record.createdFrom,
          "createdFrom",
          ACTION_ITEM_CREATED_FROM
        );
  const sourceAnalysisId = readOptionalId(
    record.sourceAnalysisId,
    "sourceAnalysisId"
  );
  const sourceHypothesisId = readOptionalId(
    record.sourceHypothesisId,
    "sourceHypothesisId"
  );
  const sourceLabel = readOptionalText(
    record.sourceLabel,
    "sourceLabel",
    ACTION_ITEM_LIMITS.sourceLabelMax
  );

  if (createdFrom === "manual") {
    if (sourceAnalysisId || sourceHypothesisId || sourceLabel) {
      throw new InvestigationValidationError(
        "A manually written action item cannot carry analysis provenance"
      );
    }
  } else {
    if (!sourceAnalysisId && !sourceHypothesisId) {
      throw new InvestigationValidationError(
        "An analysis-derived action item needs a source analysis or hypothesis"
      );
    }

    if (!sourceLabel) {
      throw new InvestigationValidationError(
        "An analysis-derived action item needs a source label"
      );
    }
  }

  return {
    title,
    description,
    priority,
    assigneeUserId,
    dueAt,
    createdFrom,
    sourceAnalysisId,
    sourceHypothesisId,
    sourceLabel,
  };
}

export type UpdateActionItemInput = {
  title?: string;
  description?: string | null;
  priority?: ActionItemPriority;
  assigneeUserId?: string | null;
  dueAt?: string | null;
  status?: ActionItemStatus;
  blockedReason?: string | null;
  expectedUpdatedAt?: string;
};

/**
 * Provenance is write-once. Rejecting the field instead of silently ignoring it
 * makes it obvious that provenance is not a normal editable attribute.
 */
const IMMUTABLE_PROVENANCE_FIELDS = [
  "createdFrom",
  "sourceAnalysisId",
  "sourceHypothesisId",
  "sourceLabel",
] as const;

export function validateUpdateActionItem(
  payload: unknown
): UpdateActionItemInput {
  const record = requireRecord(payload);

  for (const field of IMMUTABLE_PROVENANCE_FIELDS) {
    if (hasKey(record, field)) {
      throw new InvestigationValidationError(`${field} is immutable`);
    }
  }

  const update: UpdateActionItemInput = {};
  let changes = 0;

  if (hasKey(record, "title")) {
    update.title = readRequiredString(
      record.title,
      "Title",
      ACTION_ITEM_LIMITS.titleMin,
      ACTION_ITEM_LIMITS.titleMax
    );
    changes += 1;
  }

  if (hasKey(record, "description")) {
    update.description = readOptionalText(
      record.description,
      "Description",
      ACTION_ITEM_LIMITS.descriptionMax
    );
    changes += 1;
  }

  if (hasKey(record, "priority")) {
    update.priority = readEnum(
      record.priority,
      "Priority",
      ACTION_ITEM_PRIORITIES
    );
    changes += 1;
  }

  if (hasKey(record, "assigneeUserId")) {
    update.assigneeUserId = readOptionalUuid(
      record.assigneeUserId,
      "assigneeUserId"
    );
    changes += 1;
  }

  if (hasKey(record, "dueAt")) {
    update.dueAt = readOptionalTimestamp(record.dueAt, "dueAt");
    changes += 1;
  }

  if (hasKey(record, "status")) {
    update.status = readEnum(record.status, "Status", ACTION_ITEM_STATUSES);
    changes += 1;
  }

  if (hasKey(record, "blockedReason")) {
    update.blockedReason = readOptionalText(
      record.blockedReason,
      "Blocked reason",
      ACTION_ITEM_LIMITS.blockedReasonMax
    );
    changes += 1;
  }

  if (hasKey(record, "expectedUpdatedAt")) {
    update.expectedUpdatedAt = readRequiredTimestamp(
      record.expectedUpdatedAt,
      "expectedUpdatedAt"
    );
  }

  if (changes === 0) {
    throw new InvestigationValidationError("No supported fields to update");
  }

  return update;
}

export type ActionItemLifecycleState = {
  status: ActionItemStatus;
  blockedReason: string | null;
  completedAt: string | null;
  completedBy: string | null;
};

export type ActionItemStatusChangeRequest = {
  status?: ActionItemStatus | undefined;
  blockedReason?: string | null | undefined;
};

export type ActionItemStatusChangeResult = {
  state: ActionItemLifecycleState;
  changed: boolean;
  /**
   * The reason that was cleared by moving out of `blocked`, so the event history
   * can record what it said instead of silently dropping it.
   */
  previousBlockedReason: string | null;
};

/**
 * Only these transitions are accepted. Reopening a completed item returns it to
 * `open`; it never jumps straight back to `in_progress` or `blocked`.
 */
const ALLOWED_TRANSITIONS: Record<
  ActionItemStatus,
  readonly ActionItemStatus[]
> = {
  open: ["in_progress", "blocked", "completed"],
  in_progress: ["open", "blocked", "completed"],
  blocked: ["open", "in_progress", "completed"],
  completed: ["open"],
};

export function assertActionItemStatusTransition(
  from: ActionItemStatus,
  to: ActionItemStatus
): void {
  if (from === to) {
    return;
  }

  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new InvestigationConflictError(
      `Cannot move an action item from '${from}' to '${to}'`
    );
  }
}

/**
 * Work out the resulting state of a status change.
 *
 *   * a blocked item always has a non-empty reason;
 *   * leaving `blocked` clears the reason;
 *   * completing stamps the moment and the person;
 *   * reopening clears both completion fields.
 */
export function applyActionItemStatusChange(input: {
  current: ActionItemLifecycleState;
  request: ActionItemStatusChangeRequest;
  now: string;
  actorUserId: string;
}): ActionItemStatusChangeResult {
  const { current, request, now, actorUserId } = input;
  const targetStatus = request.status ?? current.status;

  assertActionItemStatusTransition(current.status, targetStatus);

  const requestedReason = request.blockedReason;
  const reason =
    requestedReason === undefined ? current.blockedReason : requestedReason;
  const normalizedReason =
    reason === null || reason.trim() === "" ? null : reason.trim();

  if (targetStatus === "blocked") {
    if (normalizedReason === null) {
      throw new InvestigationValidationError(
        "A blocked action item requires a blocked reason"
      );
    }
  } else if (requestedReason !== undefined && normalizedReason !== null) {
    throw new InvestigationValidationError(
      "A blocked reason can only be set while the action item is blocked"
    );
  }

  if (targetStatus === current.status) {
    const nextReason = targetStatus === "blocked" ? normalizedReason : null;

    return {
      state: { ...current, blockedReason: nextReason },
      changed: nextReason !== current.blockedReason,
      previousBlockedReason: current.blockedReason,
    };
  }

  if (targetStatus === "completed") {
    return {
      state: {
        status: "completed",
        blockedReason: null,
        completedAt: now,
        completedBy: actorUserId,
      },
      changed: true,
      previousBlockedReason: current.blockedReason,
    };
  }

  return {
    state: {
      status: targetStatus,
      blockedReason: targetStatus === "blocked" ? normalizedReason : null,
      completedAt: null,
      completedBy: null,
    },
    changed: true,
    previousBlockedReason: current.blockedReason,
  };
}

export type ActionItemAssigneeFilter =
  | { kind: "me" }
  | { kind: "unassigned" }
  | { kind: "user"; userId: string };

export type ListActionItemsQuery = {
  status?: ActionItemStatus;
  priority?: ActionItemPriority;
  assignee?: ActionItemAssigneeFilter;
  limit: number;
  offset: number;
};

function parseAssigneeFilter(value: string): ActionItemAssigneeFilter {
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

export function validateListActionItemsQuery(
  query: unknown
): ListActionItemsQuery {
  const record = isRecord(query) ? query : {};
  const result: ListActionItemsQuery = {
    limit: ACTION_ITEM_LIMITS.listDefaultLimit,
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
    result.assignee = parseAssigneeFilter(assignee.trim());
  }

  const limit = readQueryValue(record.limit, "limit");
  if (limit !== undefined && limit !== "") {
    result.limit = readBoundedInteger(
      limit,
      "limit",
      1,
      ACTION_ITEM_LIMITS.listMaxLimit
    );
  }

  const offset = readQueryValue(record.offset, "offset");
  if (offset !== undefined && offset !== "") {
    result.offset = readBoundedInteger(
      offset,
      "offset",
      0,
      ACTION_ITEM_LIMITS.listMaxOffset
    );
  }

  return result;
}

/**
 * A malformed action-item id is reported as not found, for the same reason the
 * investigation id is: a cross-tenant probe should not learn that the id format
 * was wrong.
 */
export function normalizeActionItemId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new InvestigationNotFoundError("Action item not found");
  }

  return value.trim();
}
