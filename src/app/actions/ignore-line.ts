"use server";

// Server Actions to mark a bank line IGNORED / un-IGNORED.
//
// IGNORED is the workflow escape hatch for lines that don't require
// reconciliation against the GL — common cases:
//   - Internal transfer between the company's own accounts (cleared
//     in the contra account, not a GL event)
//   - Bank-side adjustment that was already booked manually
//   - Test transaction the CPA reviewed and confirmed irrelevant
//
// IGNORED is NOT "I gave up" — it's an explicit human decision recorded
// in the audit trail (ignoredBy, ignoredAt, ignoreReason). To revert,
// unignoreLineAction flips it back to UNMATCHED.
//
// Neither action writes to ledger-core. No JE is posted; ignoring is
// purely a recon-side state change.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";

export interface IgnoreLineState {
  ok: boolean;
  message: string;
}

// SECURITY (pen-test pass 4): ignore/unignore both authenticate and
// tenant-scope the bank-line lookup via the chain bankLine → statement
// → bankAccount → entity → tenantId. Previously any signed-in user
// could ignore foreign-tenant lines.

const tenantWhereFor = (tenantId: string) => ({
  statement: { bankAccount: { entity: { tenantId } } },
});

/**
 * Mark an UNMATCHED bank line as IGNORED. Reversible via unignoreLineAction.
 *
 * Reason is optional but recommended; auditors reviewing the recon trail
 * later will want to know why a line was excluded.
 */
export async function ignoreLineAction(input: {
  bankLineId: string;
  reason?: string;
  ignoredBy?: string;
}): Promise<IgnoreLineState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    const line = await prisma.bankStatementLine.findFirst({
      where: { id: input.bankLineId, ...tenantWhereFor(tenant.id) },
      select: { id: true, status: true, statementId: true },
    });
    if (!line) return { ok: false, message: "Bank line not found in this tenant" };
    if (line.status === "IGNORED") {
      return { ok: true, message: "Line already IGNORED." };
    }
    if (line.status === "MATCHED" || line.status === "ADJUSTMENT") {
      // Refuse to ignore a resolved line — would obscure the audit trail.
      // Human must unwind the match / adjustment first.
      return {
        ok: false,
        message:
          `Line is ${line.status}. Reverse the match/adjustment before ignoring.`,
      };
    }

    await prisma.$transaction(async (tx) => {
      // Withdraw any pending proposed matches — no longer relevant.
      await tx.reconciliationMatch.updateMany({
        where: { bankLineId: line.id, status: "PROPOSED" },
        data: { status: "WITHDRAWN" },
      });
      await tx.bankStatementLine.update({
        where: { id: line.id },
        data: {
          status: "IGNORED",
          ignoredAt: new Date(),
          // ignoredBy stamped from the authenticated user, ignoring
          // caller-supplied input.ignoredBy (kept as a parameter for
          // backward compat but no longer trusted as identity).
          ignoredBy: user.email,
          ignoreReason: input.reason?.trim() || null,
        },
      });
      // Update statement counters. UNMATCHED + PROPOSED rows were
      // counted as "pending"; IGNORED is also pending-adjacent (not
      // matched, not actively requiring attention). We move it OUT of
      // pendingLines so the progress bar reflects resolution.
      if (line.status === "UNMATCHED" || line.status === "PROPOSED") {
        await tx.bankStatement.update({
          where: { id: line.statementId },
          data: { pendingLines: { decrement: 1 } },
        });
      }
    });

    revalidatePath(`/statements/${line.statementId}`);
    return { ok: true, message: "Line marked IGNORED." };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Reverse an IGNORED line back to UNMATCHED. Audit columns kept so
 * "who ignored, who restored" is visible in the trail.
 */
export async function unignoreLineAction(
  bankLineId: string
): Promise<IgnoreLineState> {
  try {
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    const line = await prisma.bankStatementLine.findFirst({
      where: { id: bankLineId, ...tenantWhereFor(tenant.id) },
      select: { id: true, status: true, statementId: true },
    });
    if (!line) return { ok: false, message: "Bank line not found in this tenant" };
    if (line.status !== "IGNORED") {
      return { ok: false, message: `Line is ${line.status}, not IGNORED.` };
    }

    await prisma.$transaction(async (tx) => {
      await tx.bankStatementLine.update({
        where: { id: line.id },
        // Audit columns deliberately preserved — auditors expect to
        // see the full history including the un-ignore.
        data: { status: "UNMATCHED" },
      });
      await tx.bankStatement.update({
        where: { id: line.statementId },
        data: { pendingLines: { increment: 1 } },
      });
    });

    revalidatePath(`/statements/${line.statementId}`);
    return { ok: true, message: "Line restored to UNMATCHED." };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
