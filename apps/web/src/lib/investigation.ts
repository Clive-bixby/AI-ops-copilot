import type {
  ActionItem,
  ActionItemPriority,
  ActionItemStatus,
  AnalysisHypothesis,
  EvidenceRelevance,
  Investigation,
  InvestigationSeverity,
  InvestigationStatus,
  TimelineCorrelation,
} from './types';
import type { BadgeTone } from '../components/ui';

export const INVESTIGATION_STATUSES: InvestigationStatus[] = [
  'open',
  'investigating',
  'resolved',
  'closed',
];

export const INVESTIGATION_SEVERITIES: InvestigationSeverity[] = [
  'low',
  'medium',
  'high',
  'critical',
];

/**
 * Display-only mirror of the backend lifecycle in `apps/api/.../policy.ts`.
 *
 * The backend is the authority and rejects anything else. This table exists so
 * the UI can avoid offering a control that would certainly fail; it must be kept
 * in sync with the policy rather than becoming a second source of truth.
 */
export const ALLOWED_STATUS_TRANSITIONS: Record<
  InvestigationStatus,
  InvestigationStatus[]
> = {
  open: ['investigating', 'closed'],
  investigating: ['resolved', 'closed'],
  resolved: ['investigating', 'closed'],
  closed: ['investigating'],
};

export const ACTION_ITEM_STATUSES: ActionItemStatus[] = [
  'open',
  'in_progress',
  'blocked',
  'completed',
];

export const ACTION_ITEM_PRIORITIES: ActionItemPriority[] = [
  'low',
  'medium',
  'high',
  'critical',
];

/**
 * Display-only mirror of the action-item lifecycle in
 * `apps/api/.../actionItems/policy.ts`. The backend remains authoritative.
 */
export const ALLOWED_ACTION_ITEM_TRANSITIONS: Record<
  ActionItemStatus,
  ActionItemStatus[]
> = {
  open: ['in_progress', 'blocked', 'completed'],
  in_progress: ['open', 'blocked', 'completed'],
  blocked: ['open', 'in_progress', 'completed'],
  completed: ['open'],
};

export function actionItemStatusTone(
  status: string | null | undefined
): BadgeTone {
  if (status === 'open') return 'primary';
  if (status === 'in_progress') return 'warn';
  if (status === 'blocked') return 'critical';
  if (status === 'completed') return 'ok';
  return 'neutral';
}

export function actionItemPriorityTone(
  priority: string | null | undefined
): BadgeTone {
  if (priority === 'critical') return 'critical';
  if (priority === 'high') return 'accent';
  if (priority === 'medium') return 'warn';
  return 'neutral';
}

export function actionItemAssigneeLabel(
  item: Pick<ActionItem, 'assigneeEmail' | 'assigneeUserId'>
): string {
  if (item.assigneeEmail) return item.assigneeEmail;
  if (item.assigneeUserId) return item.assigneeUserId;
  return 'Unassigned';
}

export function investigationStatusTone(status: string | null | undefined): BadgeTone {
  if (status === 'open') return 'primary';
  if (status === 'investigating') return 'warn';
  if (status === 'resolved') return 'ok';
  return 'neutral';
}

export function severityTone(severity: string | null | undefined): BadgeTone {
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'accent';
  if (severity === 'medium') return 'warn';
  return 'neutral';
}

export function relevanceTone(relevance: EvidenceRelevance): BadgeTone {
  if (relevance === 'direct') return 'ok';
  if (relevance === 'historical') return 'primary';
  if (relevance === 'related') return 'warn';
  return 'neutral';
}

export function hypothesisTone(status: AnalysisHypothesis['status']): BadgeTone {
  if (status === 'supported') return 'ok';
  if (status === 'unverified') return 'warn';
  return 'neutral';
}

export function sourceLabel(sourceType: string): string {
  if (sourceType === 'log') return 'Log group';
  if (sourceType === 'ticket') return 'Ticket';
  return 'Document';
}

export function correlationLabel(value: TimelineCorrelation): string {
  return value.replace(/_/g, ' ');
}

export function ownerLabel(
  investigation: Pick<Investigation, 'ownerEmail' | 'ownerUserId'>
): string {
  if (investigation.ownerEmail) return investigation.ownerEmail;
  if (investigation.ownerUserId) return investigation.ownerUserId;
  return 'Unassigned';
}

/** Convert an ISO timestamp to the value a datetime-local input expects. */
export function toDateTimeLocal(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/** Convert a datetime-local value to the ISO timestamp the API stores. */
export function fromDateTimeLocal(value: string): string | null {
  if (!value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
