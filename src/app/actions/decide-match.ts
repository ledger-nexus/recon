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
// Neither action writes to ledger-core. Adjustment-JE posting (the path
// that calls into ledger-core's postJournalEntry) ships in v0.2-beta.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";

export interface DecideMatchState {
  ok: boolean;
  message: string;
}

export async function approveMatchAction(
  matchId: string,
  approvedBy?: string
): Promise<DecideMatchState> {
  try {
    const match = await prisma.reconciliationMatch.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        status: true,
        bankLineId: true,
        bankLine: { select: { statementId: true } },
      },
    });
    if (!match) return { ok: false, message: "Match not found" };
    if (match.status !== "PROPOSED") {
      return { ok: false, message: `Match is ${match.status}, not PROPOSED` };
    }

    await prisma.$transaction(async (tx) => {
      await tx.reconciliationMatch.update({
        where: { id: matchId },
        data: {
          status: "APPROVED",
          approvedAt: new Date(),
          approvedBy: approvedBy ?? null,
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
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function rejectMatchAction(
  matchId: string,
  rejectedBy?: string
): Promise<DecideMatchState> {
  try {
    const match = await prisma.reconciliationMatch.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        status: true,
        bankLineId: true,
        bankLine: { select: { statementId: true } },
      },
    });
    if (!match) return { ok: false, message: "Match not found" };
    if (match.status !== "PROPOSED") {
      return { ok: false, message: `Match is ${match.status}, not PROPOSED` };
    }

    await prisma.$transaction(async (tx) => {
      await tx.reconciliationMatch.update({
        where: { id: matchId },
        data: {
          status: "REJECTED",
          rejectedAt: new Date(),
          rejectedBy: rejectedBy ?? null,
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
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
