const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True for a syntactically valid UUID.
 *
 * Used to reject identifiers before they reach Postgres: a malformed id is a
 * client mistake and deserves a 400, but as a query parameter against a `uuid`
 * column it raises a cast error, which turns every typo into a logged 500.
 */
export function isUuid(value: string | null | undefined): boolean {
  return typeof value === "string" && UUID_REGEX.test(value.trim());
}
