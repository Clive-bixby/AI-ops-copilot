export type NormalizedLog = {
  level: string;
  message: string;
  metadata: Record<string, unknown>;
  timestamp: string;
};

export class LogParseError extends Error {}

const RESERVED_LOG_KEYS = new Set([
  "message",
  "msg",
  "event",
  "text",
  "level",
  "severity",
  "logLevel",
  "timestamp",
  "time",
  "ts",
  "metadata",
]);

const SUPPORTED_LEVELS = new Set(["debug", "info", "warn", "error", "fatal"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSafeTimestamp(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    return new Date().toISOString();
  }

  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
}

function toSafeLevel(input: unknown): string {
  if (typeof input !== "string") {
    return "info";
  }

  const normalized = input.trim().toLowerCase();
  if (!normalized || !SUPPORTED_LEVELS.has(normalized)) {
    return "info";
  }

  return normalized;
}

function toSafeMessage(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }

  return input.trim();
}

function parseObjectLog(raw: Record<string, unknown>): NormalizedLog {
  const message = toSafeMessage(raw.message ?? raw.msg ?? raw.event ?? raw.text);
  if (!message) {
    throw new LogParseError("Log message is required");
  }

  const rawMetadata = raw.metadata;
  const metadataFromPayload = isRecord(rawMetadata) ? rawMetadata : {};

  const passThroughMetadata = Object.entries(raw).reduce<Record<string, unknown>>(
    (acc, [key, value]) => {
      if (!RESERVED_LOG_KEYS.has(key)) {
        acc[key] = value;
      }

      return acc;
    },
    {}
  );

  return {
    level: toSafeLevel(raw.level ?? raw.severity ?? raw.logLevel),
    message,
    metadata: {
      ...metadataFromPayload,
      ...passThroughMetadata,
    },
    timestamp: toSafeTimestamp(raw.timestamp ?? raw.time ?? raw.ts),
  };
}

function parseSingleLog(raw: unknown): NormalizedLog {
  if (typeof raw === "string") {
    const message = raw.trim();
    if (!message) {
      throw new LogParseError("Log message is required");
    }

    return {
      level: "info",
      message,
      metadata: {},
      timestamp: new Date().toISOString(),
    };
  }

  if (isRecord(raw)) {
    return parseObjectLog(raw);
  }

  throw new LogParseError("Log payload must be a string or object");
}

export function parseRawLogs(payload: unknown): NormalizedLog[] {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      throw new LogParseError("At least one log entry is required");
    }

    return payload.map((entry) => parseSingleLog(entry));
  }

  if (isRecord(payload) && Array.isArray(payload.logs)) {
    if (payload.logs.length === 0) {
      throw new LogParseError("At least one log entry is required");
    }

    return payload.logs.map((entry) => parseSingleLog(entry));
  }

  return [parseSingleLog(payload)];
}
