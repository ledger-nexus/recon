"use server";

// Post a multi-line adjustment for a bank line. Supersedes the
// two-line shape `postAdjustmentAction` handled — that action now
// delegates to this one for any single-counter cases.
//
// What this handles that the old single-counter action couldn't:
//
//   - Net deposits ($100 customer minus $2.50 fee = $97.50 cash):
//       DR Cash 97.50, DR Bank fees 2.50, CR AR 100.00
//   - Split payroll ($1,500 withdrawal = $1,200 wages + $300 tax):
//       CR Cash 1500, DR Wages 1200, DR Tax 300
//   - Bundled vendor wires (one payment, multiple invoices):
//       CR Cash 5000, DR AP 3200 (party V001), DR AP 1800 (party V001)
//
// Validation lives in src/lib/matching/multi-line-adjustment.ts. The
// validator computes the cash line from the bank statement, accepts
// the operator's counter lines, and enforces Σ DR = Σ CR — refusing
// any unbalanced shape before we round-trip to ledger-core.

import { revalidatePath } from "next/cache";
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
import {
  validateAdjustment,
  AdjustmentValidationError,
  type UserAdjustmentLine,
} from "@/lib/matching/multi-line-adjustment";

export interface PostMultiLineAdjustmentInput {
  bankLineId: string;
  counterLines: UserAdjustmentLine[];
  memo?: string;
  bookCode?: string;
}

export interface PostMultiLineAdjustmentState {
  ok: boolean;
  message: string;
  entryNumber?: string;
}

export async function postMultiLineAdjustmentAction(
  input: PostMultiLineAdjustmentInput
): Promise<PostMultiLineAdjustmentState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    await assertStatementOpen(prisma, {
      tenantId: tenant.id,
      bankLineId: input.bankLineId,
    });

    // SECURITY (pen-test pass 4): tenant-scope the bank-line lookup via
    // bankAccount.entity.tenantId, identical to single-counter action.
    const bankLine = await prisma.bankStatementLine.findFirst({
      where: {
        id: input.bankLineId,
        statement: { bankAccount: { entity: { tenantId: tenant.id } } },
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
    if (!bankLine) {
      return { ok: false, message: "Bank line not found in this tenant" };
    }
    if (bankLine.status === "MATCHED" || bankLine.status === "ADJUSTMENT") {
      return {
        ok: false,
        message: `Bank line is already ${bankLine.status} — refusing to double-post`,
      };
    }

    // Validate + build the line array. Throws AdjustmentValidationError
    // with a specific human-readable message; the catch surfaces it.
    const validated = validateAdjustment({
      cashAccountCode: bankLine.statement.bankAccount.account.code,
      bankLineAmount: bankLine.amount.toString(),
      counterLines: input.counterLines,
    });

    const entityCode = bankLine.statement.bankAccount.entity.code;
    const memo =
      input.memo?.trim() ||
      `Adjustment for unmatched bank line: ${bankLine.description}`;

    const entryInput: LedgerJournalEntryInput = {
      entityCode,
      bookCode: input.bookCode,
      documentDate: bankLine.transactionDate,
      memo,
      source: "MANUAL",
      lines: validated.lines,
      sourceSystem: "recon",
      sourceRecordType: "bank-line-adjustment",
      sourceRecordId: bankLine.id,
    };

    // ATOMICITY: wrap the bridge call + local writes in a single
    // transaction. Audit-pass fix.
    //
    // Pre-fix: postEntryViaLedgerCore ran before the local
    // $transaction. A network/DB failure after a successful bridge
    // post left the JE orphaned upstream. Two concurrent clicks
    // could pass the status check at line ~100, both call the
    // bridge (which dedupes by sourceRecordId so no double JE), but
    // each ran a fresh local txn — creating duplicate
    // ReconciliationMatch rows and double-incrementing statement
    // counters.
    //
    // Wrapping the bridge call inside the txn means: if the local
    // writes fail, the txn rolls back; on retry the bridge dedupe
    // returns the same JE and the local writes happen ONCE.
    // Default interactive-tx timeout is 5s; bridge HTTP can take a
    // few seconds, so we bump to 30s.
    const postedEntryNumberRef: { value: string } = { value: "" };

    await prisma.$transaction(
      async (tx) => {
        // Conditional transition FIRST — claims the row via
        // updateMany's row lock and short-circuits the bridge call
        // in the concurrent-loss case. Postgres serializes
        // concurrent transactions on this row; the second tx waits
        // for the first to commit/abort then re-evaluates WHERE.
        //
        // Pre-fix used unconditional tx.bankStatementLine.update,
        // which would let two concurrent calls both transition the
        // line (UNMATCHED → ADJUSTMENT then ADJUSTMENT → ADJUSTMENT
        // is a no-op success), each creating a ReconciliationMatch
        // and each incrementing statement counters.
        const transitionResult = await tx.bankStatementLine.updateMany({
          where: {
            id: bankLine.id,
            status: { in: ["UNMATCHED", "PROPOSED"] },
          },
          data: { status: "ADJUSTMENT" },
        });
        if (transitionResult.count === 0) {
          throw new Error(
            `Bank line was already resolved by a concurrent action — refusing to double-post`
          );
        }

        // Bridge call only after we've won the race. If anything
        // below fails, the txn rolls back including the status
        // transition; on retry the bridge dedupes by sourceRecordId.
        const posted = await postEntryViaLedgerCore(entryInput);

        // ReconciliationMatch always points at lineNo=1, which is the
        // cash line (the validator places it first). That keeps the
        // existing schema invariant: each bank line traces to one
        // journal line — the one that hit cash.
        const cashJeLine = await tx.journalLine.findUnique({
          where: { entryId_lineNo: { entryId: posted.id, lineNo: 1 } },
          select: { id: true },
        });
        if (!cashJeLine) {
          throw new Error(
            `Posted entry ${posted.entryNumber} but could not find its cash line to link the match`
          );
        }

        await tx.reconciliationMatch.create({
          data: {
            bankLineId: bankLine.id,
            journalLineId: cashJeLine.id,
            source: "MANUAL",
            confidence: null,
            status: "APPROVED",
            appliedByEntryId: posted.id,
            approvedAt: new Date(),
            approvedBy: user.email,
          },
        });
        await tx.reconciliationMatch.updateMany({
          where: { bankLineId: bankLine.id, status: "PROPOSED" },
          data: { status: "WITHDRAWN" },
        });
        // Statement counter — guaranteed safe because the conditional
        // transition above just confirmed the line WAS pending.
        await tx.bankStatement.update({
          where: { id: bankLine.statementId },
          data: {
            matchedLines: { increment: 1 },
            pendingLines: { decrement: 1 },
          },
        });
        postedEntryNumberRef.value = posted.entryNumber;
      },
      { timeout: 30_000 }
    );

    revalidatePath(`/statements/${bankLine.statementId}`);
    return {
      ok: true,
      message: `Posted ${postedEntryNumberRef.value} via ledger-core (${validated.lines.length} lines)`,
      entryNumber: postedEntryNumberRef.value,
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
    if (e instanceof AdjustmentValidationError) {
      return { ok: false, message: e.message };
    }
    if (e instanceof LedgerCoreError) {
      return { ok: false, message: friendlyLedgerError(e) };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
