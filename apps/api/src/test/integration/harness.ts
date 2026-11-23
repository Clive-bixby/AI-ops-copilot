import { once } from "node:events";
import type { AddressInfo } from "node:net";

import jwt from "jsonwebtoken";

/**
 * Integration-test harness.
 *
 * The suite runs against a real PostgreSQL database because the behaviour under
 * test lives in SQL: composite foreign keys, CHECK constraints, row locks and
 * tenant scoping. Mocking the pool would only assert that the mock was called.
 *
 * `TEST_DATABASE_URL` is required and is the only connection string this harness
 * uses. It never falls back to `DATABASE_URL`: a developer with a production
 * connection exported must not be able to run a suite that truncates tables.
 */

let poolRef: import("pg").Pool | null = null;
let counter = 0;

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "(unparseable connection string)";
  }
}

export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();

  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is required to run the integration suite. " +
        "It must point at a disposable database; the suite truncates tables."
    );
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("The integration suite refuses to run with NODE_ENV=production.");
  }

  return url;
}

/**
 * Point the application at the test database, apply the real migrations and
 * verify the connection. Any failure aborts the run instead of skipping tests.
 */
export async function setupTestDatabase(): Promise<void> {
  const url = requireTestDatabaseUrl();

  // Set before the db module is imported; core/db reads DATABASE_URL once.
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
  process.env.JWT_SECRET = process.env.JWT_SECRET?.trim() || "integration-test-secret";

  try {
    // Dynamic imports keep module evaluation after the environment is fixed.
    const { runMigrations } = await import("../../scripts/migrate.js");
    await runMigrations({ quiet: true });

    const { pool } = await import("../../core/db.js");
    poolRef = pool;
    await pool.query("SELECT 1");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not prepare the integration database at ${redact(url)}: ${message}`
    );
  }
}

export function getPool(): import("pg").Pool {
  if (!poolRef) {
    throw new Error("setupTestDatabase() must run before the pool is used");
  }

  return poolRef;
}

export function hasPool(): boolean {
  return poolRef !== null;
}

/** Remove every row. Organizations cascade to the tenant-scoped tables. */
export async function resetDatabase(): Promise<void> {
  await getPool().query("TRUNCATE users, organizations RESTART IDENTITY CASCADE");
}

export async function createOrganization(name: string): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
    [name]
  );

  return result.rows[0]!.id;
}

/**
 * A user row without a usable password. Integration tests authenticate with a
 * signed token, so hashing a password here would only slow the suite down.
 */
export async function createUser(email?: string): Promise<string> {
  counter += 1;
  const address = email ?? `user-${counter}-${Date.now()}@example.test`;
  const result = await getPool().query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
    [address, "not-a-real-hash"]
  );

  return result.rows[0]!.id;
}

export async function addMembership(
  userId: string,
  organizationId: string,
  role: "owner" | "admin" | "member" = "member"
): Promise<void> {
  await getPool().query(
    "INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, $3)",
    [userId, organizationId, role]
  );
}

export function tokenFor(userId: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET was not configured by setupTestDatabase()");
  }

  return jwt.sign({ userId }, secret, { expiresIn: "1h" });
}

export type TestServer = {
  url: string;
  close: () => Promise<void>;
};

/** Start the real Express app on an ephemeral port. */
export async function startServer(): Promise<TestServer> {
  const { createApp } = await import("../../app.js");
  const app = createApp({ disableRateLimit: true });
  const server = app.listen(0);
  await once(server, "listening");

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

export type ApiResponse<T = unknown> = {
  status: number;
  body: T;
};

/**
 * One request helper so tests state exactly which identity and organization
 * they act as. Omitting the token is how unauthenticated access is tested.
 */
export async function apiRequest<T = unknown>(
  baseUrl: string,
  method: string,
  path: string,
  options: {
    token?: string | null;
    organizationId?: string | null;
    body?: unknown;
  } = {}
): Promise<ApiResponse<T>> {
  const headers = new Headers();

  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.organizationId) headers.set("x-organization-id", options.organizationId);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");

  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${baseUrl}${path}`, init);

  const text = await response.text();
  let body: unknown = null;

  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }

  return { status: response.status, body: body as T };
}
