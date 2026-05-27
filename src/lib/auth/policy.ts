// Per-tenant role-based access control policy. Mirror of ledger-core's
// src/lib/auth/policy.ts — same hierarchy, same named permissions.
//
// recon doesn't need the full ledger-core permission catalog (it has
// no admin pages, no period close, no AI budget config UI). The
// permissions kept here are the ones that COULD apply to recon Server
// Actions: posting adjustment JEs (canPostJournalEntries), approving
// AI match suggestions (canApproveAiSuggestions), running reports
// (canViewReports).
//
// When the canonical rubric in ledger-core changes (a new role joins,
// a permission moves between roles), update this file too.

import type { TenantRole } from "@prisma/client";

const ROLE_RANK: Record<TenantRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN:  2,
  OWNER:  3,
};

function meets(actual: TenantRole | undefined | null, required: TenantRole): boolean {
  if (!actual) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// READ
export const canViewReports = (role: TenantRole | undefined | null): boolean =>
  meets(role, "VIEWER");

// WRITE — MEMBER+ for everything mutational in recon.
export const canPostJournalEntries = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

export const canApproveAiSuggestions = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

export const canIgnoreBankLines = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

// ADMIN — recon doesn't have admin surfaces today, but the helper
// exists for future use (e.g. a /admin/bulk-reset surface).
export const canViewAdminPages = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export class PermissionDeniedError extends Error {
  constructor(public readonly permission: string, public readonly role: TenantRole | null) {
    super(
      role
        ? `This action requires a higher role than ${role}. (permission: ${permission})`
        : `This action requires being signed in to a tenant. (permission: ${permission})`
    );
    this.name = "PermissionDeniedError";
  }
}

export function requirePermission(
  permission: string,
  role: TenantRole | null,
  check: (r: TenantRole | null) => boolean
): void {
  if (!check(role)) throw new PermissionDeniedError(permission, role);
}
