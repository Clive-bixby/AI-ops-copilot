import fs from "node:fs";

/**
 * Database TLS policy, kept pure and separate from the pool.
 *
 * SSL used to be forced on for every connection, which made the API unable to
 * reach a plain local Postgres (the compose database included): the server
 * answers "The server does not support SSL connections" and the connection
 * fails before any query runs.
 *
 * Rules, in order:
 *   DATABASE_SSL=false   -> never use SSL (even with a CA configured)
 *   DATABASE_SSL_CA      -> TLS with certificate verification against that PEM
 *   DATABASE_SSL=true    -> always use SSL, verification off
 *   sslmode=disable      -> never use SSL
 *   sslmode=<anything>   -> use SSL, verification off
 *   loopback host        -> no SSL (local development)
 *   anything else        -> SSL, with certificate verification off
 *
 * Verification stays off without a CA because that was the previous behaviour,
 * and it is not silently turned on: a self-signed certificate would fail every
 * connection. The caller warns when TLS is on and unverified, which is the one
 * state an operator should have to make a decision about.
 */

export type DatabaseSslOptions = {
  connectionString: string | undefined;
  /** `DATABASE_SSL`: "false"/"0" disables, "true"/"1" forces TLS. */
  ssl?: string | undefined;
  /** `DATABASE_SSL_CA`: filesystem path to a PEM bundle. */
  caPath?: string | undefined;
  /** Injected in tests; defaults to reading the file synchronously. */
  readCa?: (path: string) => string;
};

export type DatabaseSslConfig =
  | { ca?: string; rejectUnauthorized: boolean }
  | undefined;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function resolveSsl(options: DatabaseSslOptions): DatabaseSslConfig {
  const explicit = options.ssl?.trim().toLowerCase();

  if (explicit === "false" || explicit === "0") {
    return undefined;
  }

  const caPath = options.caPath?.trim();

  if (caPath) {
    // A CA that cannot be read must stop the process: silently falling back to
    // an unverified connection is exactly the failure this setting exists to
    // prevent.
    try {
      const readCa = options.readCa ?? ((target: string) => fs.readFileSync(target, "utf8"));

      return { ca: readCa(caPath), rejectUnauthorized: true };
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";

      throw new Error(
        `DATABASE_SSL_CA could not be read from ${caPath}${detail}`
      );
    }
  }

  if (explicit === "true" || explicit === "1") {
    return { rejectUnauthorized: false };
  }

  if (!options.connectionString) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(options.connectionString);
  } catch {
    return undefined;
  }

  const sslmode = url.searchParams.get("sslmode");
  if (sslmode === "disable") return undefined;
  if (sslmode) return { rejectUnauthorized: false };

  if (LOOPBACK_HOSTS.has(url.hostname)) {
    return undefined;
  }

  return { rejectUnauthorized: false };
}
