import type { ErrorRequestHandler } from "express";

import { logger } from "../core/logger.js";
import type { HttpError } from "../utils/httpError.js";
import { UnsupportedFileTypeError } from "./upload.middleware.js";
import {
  AuthConfigError,
  AuthConflictError,
  AuthUnauthorizedError,
  AuthValidationError,
} from "../modules/auth/auth.service.js";
import { DocumentsValidationError } from "../modules/documents/documents.service.js";
import { LogParseError } from "../modules/logs/log.parser.js";
import { LogsValidationError } from "../modules/logs/logs.service.js";
import { TicketParseError } from "../modules/tickets/ticket.parser.js";
import { TicketsValidationError } from "../modules/tickets/tickets.service.js";
import { DocumentParserError } from "../modules/ai/documentParser.service.js";
import { DocumentProcessingError } from "../modules/ai/documentProcessing.service.js";
import {
  EmbeddingConnectionError,
  EmbeddingModelError,
  EmbeddingValidationError,
} from "../modules/ai/embedding.service.js";
import {
  RAGProviderConfigError,
  RAGProviderError,
  RAGProviderTimeoutError,
  RAGValidationError,
} from "../modules/ai/rag.service.js";
import { RetrievalValidationError } from "../modules/ai/retrieval.service.js";
import {
  InvestigationConflictError,
  InvestigationNotFoundError,
  InvestigationValidationError,
} from "../modules/investigations/errors.js";
import { AnalysisFormatError } from "../modules/investigations/analysisPolicy.js";
import { FollowUpFormatError } from "../modules/investigations/followUpPolicy.js";
import { VectorValidationError } from "../modules/ai/vector.service.js";
import {
  IdempotencyConflictError,
  IdempotencyKeyError,
} from "../modules/ingestion/idempotency.service.js";
import { MembershipValidationError } from "../modules/organization/organization.service.js";

type ErrorClass = new (...args: any[]) => Error;

/**
 * Mapping from error type to HTTP status.
 *
 * This used to key on `error.name`, which silently produced 500 for every class
 * that never set a name (all auth, logs, tickets and documents errors), so a
 * wrong password answered 500 instead of 401. `instanceof` cannot drift like
 * that, and renaming or reorganising a class is caught by the compiler.
 */
const STATUS_RULES: ReadonlyArray<readonly [ErrorClass, number]> = [
  [AuthValidationError, 400],
  [AuthConflictError, 409],
  [AuthUnauthorizedError, 401],
  [AuthConfigError, 500],
  [LogsValidationError, 400],
  [LogParseError, 400],
  [DocumentsValidationError, 400],
  [UnsupportedFileTypeError, 400],
  [TicketsValidationError, 400],
  [TicketParseError, 400],
  [EmbeddingValidationError, 400],
  [EmbeddingConnectionError, 502],
  [EmbeddingModelError, 503],
  [DocumentParserError, 400],
  [DocumentProcessingError, 500],
  [VectorValidationError, 400],
  [RetrievalValidationError, 400],
  [RAGValidationError, 400],
  [RAGProviderTimeoutError, 504],
  [RAGProviderError, 502],
  [IdempotencyKeyError, 400],
  [IdempotencyConflictError, 409],
  [InvestigationValidationError, 400],
  [MembershipValidationError, 400],
  [AnalysisFormatError, 400],
  [FollowUpFormatError, 400],
  // A malformed id and an id owned by another organization answer the same 404.
  [InvestigationNotFoundError, 404],
  [InvestigationConflictError, 409],
];

function resolveStatus(error: HttpError): number {
  if (typeof error.statusCode === "number") {
    return error.statusCode;
  }

  if (typeof error.status === "number") {
    return error.status;
  }

  for (const [ErrorType, status] of STATUS_RULES) {
    if (error instanceof ErrorType) {
      return status;
    }
  }

  return 500;
}

/**
 * 5xx errors that still deserve their own sentence.
 *
 * A 503 caused by configuration is not a crash: "Internal server error" hides
 * the one fact the operator needs (which provider is misconfigured, or that
 * fixture mode only knows recorded text) behind a message that says nothing.
 * These messages name environment variables and counts, never values or hosts.
 */
const EXPLAINED_SERVER_ERRORS: ReadonlySet<ErrorClass> = new Set([
  EmbeddingModelError,
  // A provider that is misconfigured (missing key, unknown provider name) is not
  // a crash: "GEMINI_API_KEY is required to generate an answer" is the whole
  // diagnosis, and it names an environment variable rather than a value.
  RAGProviderConfigError,
]);

export const errorMiddleware: ErrorRequestHandler = (
  err,
  req,
  res,
  _next
) => {
  const error = err as HttpError;
  const status = resolveStatus(error);
  const explained =
    status >= 500 &&
    [...EXPLAINED_SERVER_ERRORS].some((ErrorType) => error instanceof ErrorType);
  const message =
    status >= 500 && !explained
      ? "Internal server error"
      : error.message || "Request failed";

  logger.error("request.error", {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    status,
    errorName: error.name,
    errorMessage: error.message,
    stack: error.stack,
    organizationId: req.organizationId,
    userId: req.user?.id,
  });

  // The request id lets a user quote a 500 that can actually be found in logs.
  res.status(status).json({
    error: message,
    ...(req.id ? { requestId: req.id } : {}),
  });
};
