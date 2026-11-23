import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

import { pool } from "../../core/db.js";

export type RegisterInput = {
  email: string;
  password: string;
  organizationName: string;
};

export type LoginInput = {
  email: string;
  password: string;
};

type RegisterResult = {
  token: string;
};

type LoginResult = {
  token: string;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Six characters was the previous floor, which allows "123456". bcrypt at cost 12
 * makes guessing slow, but it cannot save a password that is one of the first
 * fifty an attacker tries.
 */
const PASSWORD_MIN_LENGTH = 10;
const SALT_ROUNDS = 12;

export class AuthValidationError extends Error {}
export class AuthConflictError extends Error {}
export class AuthConfigError extends Error {}
export class AuthUnauthorizedError extends Error {}

export async function register(input: RegisterInput): Promise<RegisterResult> {
  const email = (input.email || "").trim().toLowerCase();
  const password = input.password || "";
  const organizationName = (input.organizationName || "").trim();

  if (!email || !EMAIL_REGEX.test(email)) {
    throw new AuthValidationError("Valid email is required");
  }

  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    throw new AuthValidationError(
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
    );
  }

  if (!organizationName) {
    throw new AuthValidationError("Organization name is required");
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new AuthConfigError("JWT_SECRET is not configured");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const userResult = await client.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email`,
      [email, passwordHash]
    );
    const user = userResult.rows[0];
    if (!user) {
      throw new Error("Failed to create user");
    }

    const organizationResult = await client.query<{ id: string; name: string }>(
      `INSERT INTO organizations (name)
       VALUES ($1)
       RETURNING id, name`,
      [organizationName]
    );
    const organization = organizationResult.rows[0];
    if (!organization) {
      throw new Error("Failed to create organization");
    }

    const membershipResult = await client.query<{ id: string; role: string }>(
      `INSERT INTO memberships (user_id, organization_id, role)
       VALUES ($1, $2, 'owner')
       RETURNING id, role`,
      [user.id, organization.id]
    );
    const membership = membershipResult.rows[0];
    if (!membership) {
      throw new Error("Failed to create membership");
    }

    await client.query("COMMIT");

    const token = jwt.sign(
      {
        sub: user.id,
        userId: user.id,
        organizationId: organization.id,
        role: membership.role,
      },
      jwtSecret,
      {
        algorithm: "HS256",
        // Tokens cannot be revoked before they expire, so a week is a long time
        // to honour a stolen one. A day matches the compose default.
        expiresIn: process.env.JWT_EXPIRES_IN || "1d",
      }
    );

    return {
      token,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures and throw original error below.
    }

    const pgError = error as { code?: string };
    if (pgError.code === "23505") {
      throw new AuthConflictError("Email already exists");
    }

    throw error;
  } finally {
    client.release();
  }
}

export type SessionContext = {
  user: { id: string; email: string };
  organization: { id: string; name: string };
  role: string;
};

export async function getSessionContext(
  userId: string,
  organizationId: string,
  role: string
): Promise<SessionContext> {
  const result = await pool.query<{
    email: string;
    organization_name: string;
  }>(
    `SELECT u.email, o.name AS organization_name
     FROM users u
     JOIN organizations o ON o.id = $2
     WHERE u.id = $1
     LIMIT 1`,
    [userId, organizationId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new AuthUnauthorizedError("Session context not found");
  }

  return {
    user: { id: userId, email: row.email },
    organization: { id: organizationId, name: row.organization_name },
    role,
  };
}

export async function login(input: LoginInput): Promise<LoginResult> {
  const email = (input.email || "").trim().toLowerCase();
  const password = input.password || "";

  if (!email || !EMAIL_REGEX.test(email)) {
    throw new AuthValidationError("Valid email is required");
  }

  if (!password) {
    throw new AuthValidationError("Password is required");
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new AuthConfigError("JWT_SECRET is not configured");
  }

  const userResult = await pool.query<{ id: string; password_hash: string; organization_id: string; role: string }>(
    `SELECT u.id, u.password_hash, m.organization_id, m.role
     FROM users u
     LEFT JOIN memberships m ON m.user_id = u.id
     WHERE u.email = $1
     LIMIT 1`,
    [email]
  );
  const user = userResult.rows[0];

  if (!user) {
    throw new AuthUnauthorizedError("Invalid email or password");
  }

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) {
    throw new AuthUnauthorizedError("Invalid email or password");
  }

  const token = jwt.sign(
    { 
      sub: user.id,
      userId: user.id,
      organizationId: user.organization_id,
      role: user.role
    },
    jwtSecret,
    {
      algorithm: "HS256",
      expiresIn: process.env.JWT_EXPIRES_IN || "1d",
    }
  );

  return { token };
}
