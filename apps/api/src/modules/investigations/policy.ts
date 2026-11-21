import {
  InvestigationConflictError,
  InvestigationNotFoundError,
  InvestigationValidationError,
} from "./errors.js";

/**
 * Validation and lifecycle rules for investigations.
 *
 * Nothing in this file touches the database. That keeps the rules that decide
 * what a client may write — and what a status change means — testable without a
 * live Postgres, which is also what the CI unit job runs.
 */

export const INVESTIGATION_STATUSES = [
  "open",
  "investigating",
  "resolved",
  "closed",
] as const;

export type InvestigationStatus = (typeof INVESTIGATION_STATUSES)[number];

export const INVESTIGATION_SEVERITIES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;

export type InvestigationSeverity = (typeof INVESTIGATION_SEVERITIES)[number];

export const INVESTIGATION_SOURCE_TYPES = [
  "document",
  "log",
  "ticket",
] as const;

export type InvestigationSourceType = (typeof INVESTIGATION_SOURCE_TYPES)[number];

export const INVESTIGATION_LIMITS = {
  titleMin: 3,
  titleMax: 200,
  descriptionMin: 10,
  descriptionMax: 4000,
  serviceMax: 100,
  errorSignatureMax: 500,
  resolutionSummaryMin: 10,
  resolutionSummaryMax: 2000,
  noteMin: 1,
  noteMax: 4000,
  listDefaultLimit: 20,
  listMaxLimit: 50,
  listMaxOffset: 10_000,
  queryMax: 200,
} as const;

// Any UUID version: the id comes from the client, and a malformed one is treated
// as "not found" rather than as a validation detail.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new InvestigationValidationError("Request body must be an object");
  }

  return payload;
}

function hasKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readRequiredString(
  value: unknown,
  label: string,
  min: number,
  max: number
): string {
  if (typeof value !== "string") {
    throw new InvestigationValidationError(`${label} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new InvestigationValidationError(
      `${label} must be between ${min} and ${max} characters`
    );
  }

  return trimmed;
}

function readOptionalText(
  value: unknown,
  label: string,
  max: number
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new InvestigationValidationError(`${label} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > max) {
    throw new InvestigationValidationError(
      `${label} must be no more than ${max} characters`
    );
  }

  return trimmed;
}

function readEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[]
): T {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw new InvestigationValidationError(
      `${label} must be one of: ${allowed.join(", ")}`
    );
  }

  return value as T;
}

function readOptionalTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new InvestigationValidationError(
      `${label} must be an ISO 8601 timestamp`
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvestigationValidationError(
      `${label} must be an ISO 8601 timestamp`
    );
  }

  return parsed.toISOString();
}

function readRequiredTimestamp(value: unknown, label: string): string {
  const parsed = readOptionalTimestamp(value, label);
  if (parsed === null) {
    throw new InvestigationValidationError(
      `${label} must be an ISO 8601 timestamp`
    );
  }

  return parsed;
}

/**
 * Source preferences. `null` means "every source type"; an explicit empty array
 * means the same thing, because searching nothing is not a useful investigation.
 */
export function validateSourceTypes(
  value: unknown
): InvestigationSourceType[] | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (!Array.isArray(value)) {
    throw new InvestigationValidationError("sourceTypes must be an array");
  }

  const unique: InvestigationSourceType[] = [];

  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      !(INVESTIGATION_SOURCE_TYPES as readonly string[]).includes(entry)
    ) {
      throw new InvestigationValidationError(
        `Unsupported source type '${String(entry)}'`
      );
    }

    const sourceType = entry as InvestigationSourceType;
    if (!unique.includes(sourceType)) {
      unique.push(sourceType);
    }
  }

  return unique.length > 0 ? unique : null;
}

export function assertWindowOrder(
  start: string | null,
  end: string | null
): void {
  if (start === null || end === null) {
    return;
  }

  if (new Date(end).getTime() <= new Date(start).getTime()) {
    throw new InvestigationValidationError(
      "windowEnd must be after windowStart"
    );
  }
}

export type CreateInvestigationInput = {
  title: string;
  description: string;
  severity: InvestigationSeverity;
  service: string | null;
  errorSignature: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  sourceTypes: InvestigationSourceType[] | null;
  /**
   * Accepted on create so a client can ask for evidence collection in the same
   * action. Evidence collection itself lives in the evidence service.
   */
  collectEvidence: boolean;
};

export function validateCreateInvestigation(
  payload: unknown
): CreateInvestigationInput {
  const record = requireRecord(payload);

  const title = readRequiredString(
    record.title,
    "Title",
    INVESTIGATION_LIMITS.titleMin,
    INVESTIGATION_LIMITS.titleMax
  );
  const description = readRequiredString(
    record.description,
    "Description",
    INVESTIGATION_LIMITS.descriptionMin,
    INVESTIGATION_LIMITS.descriptionMax
  );
  const severity =
    record.severity === undefined || record.severity === null
      ? "medium"
      : readEnum(record.severity, "Severity", INVESTIGATION_SEVERITIES);
  const service = readOptionalText(
    record.service,
    "Service",
    INVESTIGATION_LIMITS.serviceMax
  );
  const errorSignature = readOptionalText(
    record.errorSignature,
    "Error signature",
    INVESTIGATION_LIMITS.errorSignatureMax
  );
  const windowStart = readOptionalTimestamp(record.windowStart, "windowStart");
  const windowEnd = readOptionalTimestamp(record.windowEnd, "windowEnd");
  const sourceTypes = validateSourceTypes(record.sourceTypes);

  if (record.collectEvidence !== undefined && typeof record.collectEvidence !== "boolean") {
    throw new InvestigationValidationError(
      "collectEvidence must be a boolean"
    );
  }
  const collectEvidence = record.collectEvidence === true;

  assertWindowOrder(windowStart, windowEnd);

  return {
    title,
    description,
    severity,
    service,
    errorSignature,
    windowStart,
    windowEnd,
    sourceTypes,
    collectEvidence,
  };
}

export type UpdateInvestigationInput = {
  title?: string;
  description?: string;
  severity?: InvestigationSeverity;
  service?: string | null;
  errorSignature?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  sourceTypes?: InvestigationSourceType[] | null;
  status?: InvestigationStatus;
  resolutionSummary?: string | null;
  expectedUpdatedAt?: string;
};

export function validateUpdateInvestigation(
  payload: unknown
): UpdateInvestigationInput {
  const record = requireRecord(payload);
  const update: UpdateInvestigationInput = {};
  let changes = 0;

  if (hasKey(record, "title")) {
    update.title = readRequiredString(
      record.title,
      "Title",
      INVESTIGATION_LIMITS.titleMin,
      INVESTIGATION_LIMITS.titleMax
    );
    changes += 1;
  }

  if (hasKey(record, "description")) {
    update.description = readRequiredString(
      record.description,
      "Description",
      INVESTIGATION_LIMITS.descriptionMin,
      INVESTIGATION_LIMITS.descriptionMax
    );
    changes += 1;
  }

  if (hasKey(record, "severity")) {
    update.severity = readEnum(
      record.severity,
      "Severity",
      INVESTIGATION_SEVERITIES
    );
    changes += 1;
  }

  if (hasKey(record, "service")) {
    update.service = readOptionalText(
      record.service,
      "Service",
      INVESTIGATION_LIMITS.serviceMax
    );
    changes += 1;
  }

  if (hasKey(record, "errorSignature")) {
    update.errorSignature = readOptionalText(
      record.errorSignature,
      "Error signature",
      INVESTIGATION_LIMITS.errorSignatureMax
    );
    changes += 1;
  }

  if (hasKey(record, "windowStart")) {
    update.windowStart = readOptionalTimestamp(record.windowStart, "windowStart");
    changes += 1;
  }

  if (hasKey(record, "windowEnd")) {
    update.windowEnd = readOptionalTimestamp(record.windowEnd, "windowEnd");
    changes += 1;
  }

  if (hasKey(record, "sourceTypes")) {
    update.sourceTypes = validateSourceTypes(record.sourceTypes);
    changes += 1;
  }

  if (hasKey(record, "status")) {
    update.status = readEnum(record.status, "Status", INVESTIGATION_STATUSES);
    changes += 1;
  }

  if (hasKey(record, "resolutionSummary")) {
    // `null` explicitly clears it; an empty string is treated the same way so a
    // form that always sends the field does not trip validation.
    const rawSummary = record.resolutionSummary;
    update.resolutionSummary =
      rawSummary === null || (typeof rawSummary === "string" && rawSummary.trim() === "")
        ? null
        : readRequiredString(
            rawSummary,
            "Resolution summary",
            INVESTIGATION_LIMITS.resolutionSummaryMin,
            INVESTIGATION_LIMITS.resolutionSummaryMax
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

export type LifecycleState = {
  status: InvestigationStatus;
  resolvedAt: string | null;
  closedAt: string | null;
  resolutionSummary: string | null;
};

/**
 * Four statuses, and only these transitions.
 *
 * `resolved` is reachable only from `investigating`: the model never promotes
 * anything to resolved, and an investigation that was never worked on cannot be
 * closed as if it had been resolved.
 */
const ALLOWED_TRANSITIONS: Record<
  InvestigationStatus,
  readonly InvestigationStatus[]
> = {
  open: ["investigating", "closed"],
  investigating: ["resolved", "closed"],
  resolved: ["investigating", "closed"],
  closed: ["investigating"],
};

export function isTerminalStatus(status: InvestigationStatus): boolean {
  return status === "closed";
}

export function assertStatusTransition(
  from: InvestigationStatus,
  to: InvestigationStatus
): void {
  if (from === to) {
    return;
  }

  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new InvestigationConflictError(
      `Cannot move an investigation from '${from}' to '${to}'`
    );
  }
}

export type StatusChangeRequest = {
  status?: InvestigationStatus | undefined;
  resolutionSummary?: string | null | undefined;
};

export type StatusChangeResult = {
  state: LifecycleState;
  changed: boolean;
  /**
   * The summary that was cleared by a reopen, so the activity entry can record
   * what the previous resolution said instead of silently dropping it.
   */
  previousResolutionSummary: string | null;
};

/**
 * Work out the resulting lifecycle state of a status change.
 *
 * Rules that are enforced here rather than only in SQL:
 *   * resolving requires a resolution summary;
 *   * reopening clears the resolution timestamps and summary;
 *   * closing a resolved investigation keeps `resolved_at` so the record still
 *     shows when it was actually resolved;
 *   * a summary cannot be attached to an investigation that is not resolved.
 */
export function applyStatusChange(input: {
  current: LifecycleState;
  request: StatusChangeRequest;
  now: string;
}): StatusChangeResult {
  const { current, request, now } = input;
  const requestedStatus = request.status;
  const targetStatus = requestedStatus ?? current.status;

  if (targetStatus === current.status) {
    assertStatusTransition(current.status, targetStatus);

    if (request.resolutionSummary !== undefined) {
      if (current.status !== "resolved") {
        throw new InvestigationValidationError(
          "A resolution summary can only be set on a resolved investigation"
        );
      }

      const summary = request.resolutionSummary;
      if (summary === null || summary.trim() === "") {
        throw new InvestigationValidationError(
          "A resolved investigation needs a resolution summary"
        );
      }

      return {
        state: { ...current, resolutionSummary: summary.trim() },
        changed: summary.trim() !== current.resolutionSummary,
        previousResolutionSummary: current.resolutionSummary,
      };
    }

    return {
      state: current,
      changed: false,
      previousResolutionSummary: current.resolutionSummary,
    };
  }

  assertStatusTransition(current.status, targetStatus);

  if (targetStatus === "resolved") {
    const summary =
      request.resolutionSummary === undefined
        ? current.resolutionSummary
        : request.resolutionSummary;

    if (summary === null || summary === undefined || summary.trim() === "") {
      throw new InvestigationValidationError(
        "Resolving an investigation requires a resolution summary"
      );
    }

    return {
      state: {
        status: "resolved",
        resolvedAt: now,
        closedAt: null,
        resolutionSummary: summary.trim(),
      },
      changed: true,
      previousResolutionSummary: current.resolutionSummary,
    };
  }

  if (targetStatus === "closed") {
    const summary =
      request.resolutionSummary === undefined
        ? current.resolutionSummary
        : request.resolutionSummary;

    return {
      state: {
        status: "closed",
        // Closing a resolved investigation keeps the moment it was resolved.
        resolvedAt: current.resolvedAt,
        closedAt: now,
        resolutionSummary: summary === undefined ? null : summary,
      },
      changed: true,
      previousResolutionSummary: current.resolutionSummary,
    };
  }

  // Reopening: the previous resolution is history, not current state.
  return {
    state: {
      status: "investigating",
      resolvedAt: null,
      closedAt: null,
      resolutionSummary: null,
    },
    changed: true,
    previousResolutionSummary: current.resolutionSummary,
  };
}

export type ListInvestigationsQuery = {
  status?: InvestigationStatus;
  severity?: InvestigationSeverity;
  service?: string;
  q?: string;
  limit: number;
  offset: number;
};

function readQueryValue(
  value: unknown,
  label: string
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  // Express can hand back an array when a query parameter is repeated.
  if (Array.isArray(value)) {
    const first = value[0];
    if (first === undefined) {
      return undefined;
    }
    if (typeof first !== "string") {
      throw new InvestigationValidationError(`${label} must be a string`);
    }
    return first;
  }

  if (typeof value !== "string") {
    throw new InvestigationValidationError(`${label} must be a string`);
  }

  return value;
}

function readBoundedInteger(
  value: string,
  label: string,
  min: number,
  max: number
): number {
  if (!/^\d+$/.test(value)) {
    throw new InvestigationValidationError(
      `${label} must be an integer between ${min} and ${max}`
    );
  }

  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw new InvestigationValidationError(
      `${label} must be an integer between ${min} and ${max}`
    );
  }

  return parsed;
}

export function validateListInvestigationsQuery(
  query: unknown
): ListInvestigationsQuery {
  const record = isRecord(query) ? query : {};
  const result: ListInvestigationsQuery = {
    limit: INVESTIGATION_LIMITS.listDefaultLimit,
    offset: 0,
  };

  const status = readQueryValue(record.status, "status");
  if (status !== undefined && status !== "") {
    result.status = readEnum(status, "status", INVESTIGATION_STATUSES);
  }

  const severity = readQueryValue(record.severity, "severity");
  if (severity !== undefined && severity !== "") {
    result.severity = readEnum(severity, "severity", INVESTIGATION_SEVERITIES);
  }

  const service = readQueryValue(record.service, "service");
  if (service !== undefined && service.trim() !== "") {
    const trimmed = service.trim();
    if (trimmed.length > INVESTIGATION_LIMITS.serviceMax) {
      throw new InvestigationValidationError(
        `service must be no more than ${INVESTIGATION_LIMITS.serviceMax} characters`
      );
    }
    result.service = trimmed;
  }

  const q = readQueryValue(record.q, "q");
  if (q !== undefined && q.trim() !== "") {
    const trimmed = q.trim();
    if (trimmed.length > INVESTIGATION_LIMITS.queryMax) {
      throw new InvestigationValidationError(
        `q must be no more than ${INVESTIGATION_LIMITS.queryMax} characters`
      );
    }
    result.q = trimmed;
  }

  const limit = readQueryValue(record.limit, "limit");
  if (limit !== undefined && limit !== "") {
    result.limit = readBoundedInteger(
      limit,
      "limit",
      1,
      INVESTIGATION_LIMITS.listMaxLimit
    );
  }

  const offset = readQueryValue(record.offset, "offset");
  if (offset !== undefined && offset !== "") {
    result.offset = readBoundedInteger(
      offset,
      "offset",
      0,
      INVESTIGATION_LIMITS.listMaxOffset
    );
  }

  return result;
}

export function validateNoteBody(payload: unknown): string {
  const record = requireRecord(payload);

  return readRequiredString(
    record.body,
    "Note",
    INVESTIGATION_LIMITS.noteMin,
    INVESTIGATION_LIMITS.noteMax
  );
}

/**
 * A malformed id is reported as not found. Returning a distinct 400 would tell a
 * caller that the id format is wrong, which is one more bit of feedback that a
 * cross-tenant probe does not need.
 */
export function normalizeInvestigationId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new InvestigationNotFoundError();
  }

  return value.trim();
}
