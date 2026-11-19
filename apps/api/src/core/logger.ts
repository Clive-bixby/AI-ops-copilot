type Level = "info" | "warn" | "error";

type Fields = Record<string, unknown>;

/**
 * One JSON object per line.
 *
 * Logs used to be free-form console output with no correlation id, so a request
 * could not be followed across its own lines and nothing downstream could parse
 * them. Errors are serialised because `JSON.stringify` drops Error internals
 * (name, message, stack are not enumerable).
 */
function write(level: Level, message: string, fields: Fields = {}): void {
  const line = JSON.stringify(
    { time: new Date().toISOString(), level, message, ...fields },
    (_key, value: unknown) =>
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value
  );

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

export const logger = {
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, fields?: Fields) => write("error", message, fields),
};
