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
const PASSWORD_MIN_LENGTH = 6;
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
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
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

  const userResult = await pool.query<{ id: string; password_hash: string }>(
    `SELECT id, password_hash
     FROM users
     WHERE email = $1`,
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
    { userId: user.id },
    jwtSecret,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );

  return { token };
}
