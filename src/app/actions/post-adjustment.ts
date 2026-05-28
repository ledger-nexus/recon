"use server";

// Post an adjustment journal entry for a bank line that has no matching
// JE in the ledger — classic example: a $50 wire fee on the bank
// statement that wasn't booked.
//
// Flow:
//   1. Resolve bank line → bank account → entity, cash account code
//   2. Build a two-line JE: cash + counter-account, signed to match
//      the bank line's direction
//      - Bank line negative (withdrawal): credit cash, debit counter
//      - Bank line positive (deposit):    debit cash,  credit counter
//   3. POST to ledger-core via the bridge with source="MANUAL"
//      (this is a human-typed entry, not AI-suggested)
//   4. On success, create a ReconciliationMatch (source=MANUAL,
//      status=APPROVED, appliedByEntryId=<new entry>) pointing at the
//      first line of the new JE (the cash line)
//   5. Flip the bank line to ADJUSTMENT + update statement counters
//
// Failure modes are surfaced verbatim from ledger-core via the
// LedgerCoreError code → user sees the same message ledger-core would
// have given them in its UI.

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import {
  postEntryViaLedgerCore,
  LedgerCoreError,
  friendlyLedgerError,
  type LedgerJournalEntryInput,
} from "@/lib/ledger-bridge";
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

export interface PostAdjustmentInput {
  bankLineId: string;
  counterAccountCode: string;  // the non-cash side, e.g. "6500" for bank fees
  memo?: string;
  partyCode?: string;
  bookCode?: string;           // default US_GAAP
  postedBy?: string;
}

export interface PostAdjustmentState {
  ok: boolean;
  message: string;
  entryNumber?: string;
}

export async function postAdjustmentAction(
  input: PostAdjustmentInput
): Promise<PostAdjustmentState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    // Refuse if the parent statement is RECONCILED. Same gate as every
    // other mutating recon action.
    await assertStatementOpen(prisma, {
      tenantId: tenant.id,
      bankLineId: input.bankLineId,
    });

    // SECURITY (pen-test pass 4): tenant-scope the bank-line lookup via
    // bankAccount.entity.tenantId. Before this gate, any signed-in
    // user could pass a foreign tenant's bankLineId and post a JE
    // against that tenant's books — the most severe finding in this
    // repo because postEntryViaLedgerCore goes all the way through to
    // a real journal entry.
    const bankLine = await prisma.bankStatementLine.findFirst({
      where: {
        id: input.bankLineId,
        statement: {
          bankAccount: { entity: { tenantId: tenant.id } },
        },
      },
      select: {
        id: true,
        amount: true,
        transactionDate: true,
        description: true,
        status: true,
        statementId: true,
        statement: {
          select: {
            bankAccount: {
              select: {
                entity: { select: { code: true } },
                account: { select: { code: true } },
              },
            },
          },
        },
      },
    });
    if (!bankLine) return { ok: false, message: "Bank line not found in this tenant" };
    if (bankLine.status === "MATCHED" || bankLine.status === "ADJUSTMENT") {
      return {
        ok: false,
        message: `Bank line is already ${bankLine.status} — refusing to double-post`,
      };
    }

    const signedAmount = new Decimal(bankLine.amount.toString());
    const absAmount = signedAmount.abs();
    if (absAmount.isZero()) {
      return { ok: false, message: "Cannot post a $0 adjustment" };
    }

    const entityCode = bankLine.statement.bankAccount.entity.code;
    const cashAccountCode = bankLine.statement.bankAccount.account.code;
    const memo =
      input.memo?.trim() ||
      `Adjustment for unmatched bank line: ${bankLine.description}`;

    // Sign convention: bank deposit (+) = cash debit; bank withdrawal (-) = cash credit.
    const cashIsDebit = signedAmount.isPositive();
    const cashLine = cashIsDebit
      ? { accountCode: cashAccountCode, debit: absAmount }
      : { accountCode: cashAccountCode, credit: absAmount };
    const counterLine = cashIsDebit
      ? { accountCode: input.counterAccountCode, credit: absAmount, partyCode: input.partyCode }
      : { accountCode: input.counterAccountCode, debit: absAmount, partyCode: input.partyCode };

    const entryInput: LedgerJournalEntryInput = {
      entityCode,
      bookCode: input.bookCode,
      documentDate: bankLine.transactionDate,
      memo,
      source: "MANUAL",
      lines: [cashLine, counterLine],
      sourceSystem: "recon",
      sourceRecordType: "bank-line-adjustment",
      sourceRecordId: bankLine.id,
    };

    const posted = await postEntryViaLedgerCore(entryInput);

    // The cash line is always lineNo=1 — we put it first in lines[]
    // above. Look it up so we can persist a ReconciliationMatch row
    // pointing at a real journal-line id.
    const cashJeLine = await prisma.journalLine.findUnique({
      where: { entryId_lineNo: { entryId: posted.id, lineNo: 1 } },
      select: { id: true },
    });
    if (!cashJeLine) {
      return {
        ok: false,
        message: `Posted entry ${posted.entryNumber} but could not find its cash line to link the match`,
      };
    }

    await prisma.$transaction(async (tx) => {
      await tx.reconciliationMatch.create({
        data: {
          bankLineId: bankLine.id,
          journalLineId: cashJeLine.id,
          source: "MANUAL",
          confidence: null,
          status: "APPROVED",
          appliedByEntryId: posted.id,
          approvedAt: new Date(),
          // Stamp the authenticated user, ignoring caller-supplied
          // postedBy (which is now informational only / kept for the
          // public API but no longer trusted as identity).
          approvedBy: user.email,
        },
      });
      // Withdraw any sibling PROPOSED matches on this bank line.
      await tx.reconciliationMatch.updateMany({
        where: { bankLineId: bankLine.id, status: "PROPOSED" },
        data: { status: "WITHDRAWN" },
      });
      await tx.bankStatementLine.update({
        where: { id: bankLine.id },
        data: { status: "ADJUSTMENT" },
      });
      const wasPending = bankLine.status === "UNMATCHED" || bankLine.status === "PROPOSED";
      if (wasPending) {
        await tx.bankStatement.update({
          where: { id: bankLine.statementId },
          data: {
            matchedLines: { increment: 1 },
            pendingLines: { decrement: 1 },
          },
        });
      }
    });

    revalidatePath(`/statements/${bankLine.statementId}`);
    return {
      ok: true,
      message: `Posted ${posted.entryNumber} via ledger-core`,
      entryNumber: posted.entryNumber,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, message: "You must be signed in to post an adjustment." };
    }
    if (e instanceof NoTenantSelectedError) {
      return { ok: false, message: e.message };
    }
    if (e instanceof StatementReconciledError || e instanceof StatementNotFoundError) {
      return { ok: false, message: e.message };
    }
    if (e instanceof LedgerCoreError) {
      return { ok: false, message: friendlyLedgerError(e) };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
