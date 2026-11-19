import { pool } from "../../core/db.js";

export type OrganizationMember = {
  userId: string;
  email: string;
  role: string;
  joinedAt: string;
};

export async function listOrganizationMembers(
  organizationId: string
): Promise<OrganizationMember[]> {
  const result = await pool.query<{
    user_id: string;
    email: string;
    role: string;
    created_at: string;
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
    joinedAt: row.created_at,
  }));
}
