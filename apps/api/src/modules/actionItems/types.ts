import type {
  ActionItemCreatedFrom,
  ActionItemPriority,
  ActionItemStatus,
} from "./policy.js";

/**
 * A unit of follow-up work attached to exactly one investigation.
 *
 * Action items are human records. `createdFrom` says whether a person wrote the
 * item or accepted a suggestion produced by an analysis; it never means the
 * system created, executed or completed the work.
 */
export type ActionItem = {
  id: string;
  organizationId: string;
  investigationId: string;
  title: string;
  description: string | null;
  status: ActionItemStatus;
  priority: ActionItemPriority;
  /** NULL means unassigned. Never inferred from the creator. */
  assigneeUserId: string | null;
  assigneeEmail: string | null;
  dueAt: string | null;
  blockedReason: string | null;
  completedAt: string | null;
  completedBy: string | null;
  completedByEmail: string | null;
  createdFrom: ActionItemCreatedFrom;
  sourceAnalysisId: string | null;
  sourceHypothesisId: string | null;
  /** Immutable snapshot of the suggestion the item came from. */
  sourceLabel: string | null;
  createdBy: string;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ActionItemEventType =
  | "created"
  | "status_change"
  | "assignee_change"
  | "priority_change"
  | "due_change"
  | "details_change";

/** One append-only entry in an action item's own history. */
export type ActionItemEvent = {
  id: string;
  type: ActionItemEventType;
  /** NULL only for a system event; every current writer attributes a person. */
  actorUserId: string | null;
  actorEmail: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type ActionItemDetail = {
  item: ActionItem;
  events: ActionItemEvent[];
};

export type ActionItemSummary = {
  total: number;
  open: number;
  inProgress: number;
  blocked: number;
  completed: number;
  /** Not completed and past its due date. */
  overdue: number;
};

export type ActionItemList = {
  items: ActionItem[];
  summary: ActionItemSummary;
  limit: number;
  offset: number;
};
