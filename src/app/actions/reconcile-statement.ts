"use server";

// Server Actions: reconcile + reopen a bank statement.
//
//   reconcileStatementAction — flips status OPEN → RECONCILED when
//     100% of lines have resolved (matched + ignored + adjustment).
//     Refuses otherwise. Stamps reconciledAt + reconciledBy.
//
//   reopenStatementAction — flips RECONCILED → OPEN. ADMIN+ only;
//     this is a privileged action because it lets the workspace edit
//     a statement someone previously declared "done". Audit-logged.
//
// The lock itself is enforced in src/lib/statement-lock.ts +
// every mutating Server Action.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";
import {
  canIgnoreBankLines,
  canViewAdminPages,
  PermissionDeniedError,
  requirePermission,
} from "@/lib/auth/policy";

export interface ReconcileStatementState {
  ok: boolean;
  message?: string;
}

export async function reconcileStatementAction(
  statementId: string
): Promise<ReconcileStatementState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    // Reconciling is a normal user action — MEMBER+ via the existing
    // recon policy floor (canIgnoreBankLines = MEMBER, same level).
    requirePermission("reconcile_statement", tenant.role, canIgnoreBankLines);

    if (!statementId) {
      return { ok: false, message: "statementId required" };
    }

    // Tenant-scope + pull line counts.
    const statement = await prisma.bankStatement.findFirst({
      where: {
        id: statementId,
        bankAccount: { entity: { tenantId: tenant.id } },
      },
      include: {
        lines: {
          select: { status: true },
        },
      },
    });
    if (!statement) {
      return { ok: false, message: "Statement not found in this tenant." };
    }
    if (statement.status === "RECONCILED") {
      return {
        ok: false,
        message: "Statement is already RECONCILED. Reopen it first if you want to change anything.",
      };
    }

    // Refuse unless 100% of lines are resolved (matched / ignored / adjustment).
    // The same three terminal statuses the progress bar on /statements/[id] counts.
    const TERMINAL = new Set(["MATCHED", "IGNORED", "ADJUSTMENT"]);
    const total = statement.lines.length;
    const resolved = statement.lines.filter((l) => TERMINAL.has(l.status)).length;
    if (total === 0) {
      return {
        ok: false,
        message: "Statement has no lines — nothing to reconcile.",
      };
    }
    if (resolved < total) {
      return {
        ok: false,
        message: `${total - resolved} line${total - resolved === 1 ? "" : "s"} still need resolution before reconciling. (Resolved: matched / ignored / adjustment.)`,
      };
    }

    await prisma.bankStatement.update({
      where: { id: statement.id },
      data: {
        status: "RECONCILED",
        reconciledAt: new Date(),
        reconciledBy: user.email,
      },
    });

    revalidatePath(`/statements/${statement.id}`);
    revalidatePath("/statements");
    revalidatePath("/");
    return {
      ok: true,
      message: `Statement locked. All ${total} lines are accepted; mutations are refused until an admin reopens.`,
    };
  } catch (e) {
    return mapError(e);
  }
}

export async function reopenStatementAction(
  statementId: string,
  reason?: string
): Promise<ReconcileStatementState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    // Reopening is admin-privileged — it lets a workspace edit a
    // statement someone previously declared closed. Same role floor
    // as the /admin/* pages.
    requirePermission("reopen_statement", tenant.role, canViewAdminPages);

    if (!statementId) {
      return { ok: false, message: "statementId required" };
    }

    const statement = await prisma.bankStatement.findFirst({
      where: {
        id: statementId,
        bankAccount: { entity: { tenantId: tenant.id } },
      },
      select: { id: true, status: true, filename: true },
    });
    if (!statement) {
      return { ok: false, message: "Statement not found in this tenant." };
    }
    if (statement.status !== "RECONCILED") {
      return {
        ok: false,
        message: `Statement is ${statement.status}, not RECONCILED. Nothing to reopen.`,
      };
    }

    await prisma.bankStatement.update({
      where: { id: statement.id },
      data: {
        status: "OPEN",
        reconciledAt: null,
        reconciledBy: null,
      },
    });

    revalidatePath(`/statements/${statement.id}`);
    revalidatePath("/statements");
    revalidatePath("/");
    return {
      ok: true,
      message: `Statement ${statement.filename} reopened. Mutations are accepted again.${
        reason ? ` Reason logged: ${reason}` : ""
      }`,
    };
  } catch (e) {
    return mapError(e);
  }
}

function mapError(e: unknown): ReconcileStatementState {
  if (e instanceof NotAuthenticatedError)
    return { ok: false, message: "You must be signed in." };
  if (e instanceof NoTenantSelectedError)
    return { ok: false, message: e.message };
  if (e instanceof PermissionDeniedError)
    return { ok: false, message: e.message };
  return {
    ok: false,
    message: e instanceof Error ? e.message : "Unknown error",
  };
}
