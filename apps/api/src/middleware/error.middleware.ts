import type { ErrorRequestHandler } from "express";
import type { HttpError } from "../utils/httpError.js";

const ERROR_STATUS_BY_NAME: Record<string, number> = {
  AuthValidationError: 400,
  AuthConflictError: 409,
  AuthUnauthorizedError: 401,
  AuthConfigError: 500,
  LogsValidationError: 400,
  LogParseError: 400,
  DocumentsValidationError: 400,
  TicketsValidationError: 400,
  TicketParseError: 400,
  EmbeddingValidationError: 400,
  EmbeddingConnectionError: 502,
  EmbeddingModelError: 503,
  DocumentParserError: 400,
  DocumentProcessingError: 500,
  VectorValidationError: 400,
};

function resolveStatus(error: HttpError): number {
  if (typeof error.statusCode === "number") {
    return error.statusCode;
  }

  if (typeof error.status === "number") {
    return error.status;
  }

  const mapped = ERROR_STATUS_BY_NAME[error.name];
  return mapped ?? 500;
}

export const errorMiddleware: ErrorRequestHandler = (
  err,
  req,
  res,
  _next
) => {
  const error = err as HttpError;
  const status = resolveStatus(error);
  const message =
    status >= 500 ? "Internal server error" : error.message || "Request failed";

  console.error(`[${req.method} ${req.originalUrl}]`, error);

  res.status(status).json({ error: message });
};
