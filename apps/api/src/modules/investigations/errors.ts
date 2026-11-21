/**
 * Investigation errors are typed so `error.middleware.ts` maps them by
 * `instanceof` instead of by a name string that can drift.
 *
 * `InvestigationNotFoundError` is also used for a malformed id on purpose: a
 * caller must not be able to tell "does not exist" from "belongs to another
 * organization", and neither case should reveal anything about tenant data.
 */
export class InvestigationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigationValidationError";
  }
}

export class InvestigationNotFoundError extends Error {
  constructor(message = "Investigation not found") {
    super(message);
    this.name = "InvestigationNotFoundError";
  }
}

export class InvestigationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigationConflictError";
  }
}
