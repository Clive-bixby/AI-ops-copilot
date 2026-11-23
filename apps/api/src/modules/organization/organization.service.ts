import { pool } from "../../core/db.js";

export type OrganizationMember = {
  userId: string;
  email: string;
  role: string;
  joinedAt: string;
};

/**
 * A client asked to assign a record to someone who is not a member of the active
 * organization. This is a validation problem, not an authorization failure: the
 * caller may assign work to any member, but not to an outsider.
 */
export class MembershipValidationError extends Error {
  constructor(message = "The selected user is not a member of this organization") {
    super(message);
    this.name = "MembershipValidationError";
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The organization's membership directory. Deliberately read-only and limited to
 * the fields an assignment picker needs; invitations and role changes remain
 * admin-only and are not part of this contract.
 */
export async function listOrganizationMembers(
  organizationId: string
): Promise<OrganizationMember[]> {
  const result = await pool.query<{
    user_id: string;
    email: string;
    role: string;
    created_at: Date | string;
  }>(
    `SELECT m.user_id, u.email, m.role, m.created_at
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1
     ORDER BY
       CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
       u.email ASC`,
    [organizationId]
  );

  return result.rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    role: row.role,
    joinedAt: toIso(row.created_at),
  }));
}

export async function findOrganizationMember(
  organizationId: string,
  userId: string
): Promise<OrganizationMember | null> {
  const result = await pool.query<{
    user_id: string;
    email: string;
    role: string;
    created_at: Date | string;
  }>(
    `SELECT m.user_id, u.email, m.role, m.created_at
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 AND m.user_id = $2`,
    [organizationId, userId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    userId: row.user_id,
    email: row.email,
    role: row.role,
    joinedAt: toIso(row.created_at),
  };
}

/**
 * Validate that an assignee belongs to the organization before writing an owner
 * column. The composite foreign key in the database is the backstop; this check
 * exists so a caller gets a clear 400 instead of a raw constraint violation.
 */
export async function assertOrganizationMember(
  organizationId: string,
  userId: string
): Promise<OrganizationMember> {
  const member = await findOrganizationMember(organizationId, userId);

  if (!member) {
    throw new MembershipValidationError();
  }

  return member;
}
