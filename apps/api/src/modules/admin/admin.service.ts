// The membership directory lives in the organization module so every member can
// read it for assignment pickers. Admin keeps using the same query, but its route
// remains owner/admin-only.
export { listOrganizationMembers } from "../organization/organization.service.js";
export type { OrganizationMember } from "../organization/organization.service.js";
