/**
 * Errors raised while turning a stored source into indexed chunks.
 *
 * They are separate from parser/embedding errors so the HTTP layer can report
 * "this source cannot be indexed" (4xx) without treating it as a server fault.
 */

export class IngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestionError";
  }
}

export class IngestionValidationError extends IngestionError {
  constructor(message: string) {
    super(message);
    this.name = "IngestionValidationError";
  }
}

export class SourceNotFoundError extends IngestionError {
  constructor(message = "Source not found") {
    super(message);
    this.name = "SourceNotFoundError";
  }
}
