"use server";

// Server Actions to approve / reject a proposed ReconciliationMatch.
//
//   - approveMatchAction: flip the match to APPROVED, the bank line to
//     MATCHED, and withdraw any sibling PROPOSED matches on the same
//     bank line (you only have one true match per line in v0.2).
//
//   - rejectMatchAction: flip the match to REJECTED. If no APPROVED
//     match remains on the bank line, the line returns to UNMATCHED so
//     it's still visible in the human queue.
//
// SECURITY (pen-test pass 4): both actions require a signed-in user
// and tenant-scope the match lookup via match → bankLine → statement
// → bankAccount → entity → tenantId. Without this gate, a signed-in
// user from tenant A could approve/reject tenant B's matches by
// supplying a foreign UUID. The approvedBy / rejectedBy fields are
// now stamped from the authenticated user, not caller-supplied input.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";
import {
  assertStatementOpen,
  StatementReconciledError,
  StatementNotFoundError,
} from "@/lib/statement-lock";

export interface DecideMatchState {
  ok: boolean;
  message: string;
}

const tenantWhereFor = (tenantId: string) => ({
  bankLine: { statement: { bankAccount: { entity: { tenantId } } } },
});

export async function approveMatchAction(
  matchId: string,
  // approvedBy retained as a parameter for backward-compat but no longer
  // trusted as identity — the authenticated user's email is stamped.
  _approvedBy?: string
): Promise<DecideMatchState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const match = await prisma.reconciliationMatch.findFirst({
      where: { id: matchId, ...tenantWhereFor(tenant.id) },
      select: {
        id: true,
        status: true,
        bankLineId: true,
        bankLine: { select: { statementId: true } },
      },
    });
    if (!match) return { ok: false, message: "Match not found in this tenant" };
    if (match.status !== "PROPOSED") {
      return { ok: false, message: `Match is ${match.status}, not PROPOSED` };
    }
    // Refuse if the parent statement is RECONCILED.
    await assertStatementOpen(prisma, {
      tenantId: tenant.id,
      statementId: match.bankLine.statementId,
    });

    await prisma.$transaction(async (tx) => {
      await tx.reconciliationMatch.update({
        where: { id: matchId },
        data: {
          status: "APPROVED",
          approvedAt: new Date(),
          approvedBy: user.email,
        },
      });
      // Withdraw competing PROPOSED matches on the same bank line.
      await tx.reconciliationMatch.updateMany({
        where: {
          bankLineId: match.bankLineId,
          id: { not: matchId },
          status: "PROPOSED",
        },
        data: { status: "WITHDRAWN" },
      });
      await tx.bankStatementLine.update({
        where: { id: match.bankLineId },
        data: { status: "MATCHED" },
      });
      // Update statement aggregate counters.
      await tx.bankStatement.update({
        where: { id: match.bankLine.statementId },
        data: {
          matchedLines: { increment: 1 },
          pendingLines: { decrement: 1 },
        },
      });
    });

    revalidatePath(`/statements/${match.bankLine.statementId}`);
    return { ok: true, message: "Match approved." };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    if (e instanceof StatementReconciledError || e instanceof StatementNotFoundError)
      return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function rejectMatchAction(
  matchId: string,
  _rejectedBy?: string
): Promise<DecideMatchState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const match = await prisma.reconciliationMatch.findFirst({
      where: { id: matchId, ...tenantWhereFor(tenant.id) },
      select: {
        id: true,
        status: true,
        bankLineId: true,
        bankLine: { select: { statementId: true } },
      },
    });
    if (!match) return { ok: false, message: "Match not found in this tenant" };
    if (match.status !== "PROPOSED") {
      return { ok: false, message: `Match is ${match.status}, not PROPOSED` };
    }
    // Refuse if the parent statement is RECONCILED.
    await assertStatementOpen(prisma, {
      tenantId: tenant.id,
      statementId: match.bankLine.statementId,
    });

    await prisma.$transaction(async (tx) => {
      await tx.reconciliationMatch.update({
        where: { id: matchId },
        data: {
          status: "REJECTED",
          rejectedAt: new Date(),
          rejectedBy: user.email,
        },
      });
      // If no PROPOSED matches remain on this bank line, fall back to
      // UNMATCHED so the human queue keeps the line visible.
      const remainingProposed = await tx.reconciliationMatch.count({
        where: { bankLineId: match.bankLineId, status: "PROPOSED" },
      });
      if (remainingProposed === 0) {
        await tx.bankStatementLine.update({
          where: { id: match.bankLineId },
          data: { status: "UNMATCHED" },
        });
      }
    });

    revalidatePath(`/statements/${match.bankLine.statementId}`);
    return { ok: true, message: "Match rejected." };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    if (e instanceof StatementReconciledError || e instanceof StatementNotFoundError)
      return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
