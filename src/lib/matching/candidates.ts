// Candidate-fetching for the match pipeline.
//
// Given a bank statement line, find the JE lines from ledger-core that
// are even worth scoring. The filter is intentionally loose — better to
// score 30 candidates and drop most than to silently miss the right one.
//
// Filter shape:
//   - account = the cash account behind the BankAccount
//   - documentDate within ±5 business days of the bank line (we use
//     calendar days because business-day math depends on the entity's
//     fiscal calendar, which is out of scope here)
//   - amount magnitude within $50 OR within 20% — captures rounding,
//     small bank fees that were booked separately, etc.
//   - status = POSTED (we never reconcile against drafts)
//   - NOT already MATCHED to any bank line (no double-claiming)
//
// Returns rows shaped to feed both the deterministic scorer and the AI
// suggester. Caller wraps them.

import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";

const DAY_WINDOW = 5;
const ABS_AMOUNT_WINDOW = new Decimal(50);
const REL_AMOUNT_WINDOW = new Decimal("0.2"); // 20%

export interface CandidateRow {
  journalLineId: string;
  jeDebit: Decimal;
  jeCredit: Decimal;
  jeDate: Date;
  jeMemo: string;
  jePartyDisplayName?: string;
}

export interface FetchInput {
  bankAccountId: string;
  bankLineAmount: Decimal; // signed
  bankLineDate: Date;
}

function dayShift(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

export async function fetchCandidateJournalLines(
  input: FetchInput
): Promise<CandidateRow[]> {
  // 1. Resolve the cash account behind this BankAccount.
  const bankAccount = await prisma.bankAccount.findUnique({
    where: { id: input.bankAccountId },
    select: { accountId: true, entityId: true },
  });
  if (!bankAccount) return [];

  // 2. Compute amount + date windows.
  const absAmt = input.bankLineAmount.abs();
  const tolerance = Decimal.max(ABS_AMOUNT_WINDOW, absAmt.times(REL_AMOUNT_WINDOW));
  const amountMin = absAmt.minus(tolerance);
  const amountMax = absAmt.plus(tolerance);

  const dateMin = dayShift(input.bankLineDate, -DAY_WINDOW);
  const dateMax = dayShift(input.bankLineDate, DAY_WINDOW);

  // 3. Direction: bank deposit (+) wants JE lines that DEBIT cash;
  //    bank withdrawal (-) wants JE lines that CREDIT cash. We encode
  //    this as: signed amount of the JE line has the same sign as the
  //    bank line, where signed = debit - credit on the cash account.
  const wantDebit = input.bankLineAmount.isPositive();

  // Query JE lines on the cash account within the windows. Exclude lines
  // already matched (any APPROVED reconciliation_match). Posted entries
  // only.
  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: bankAccount.accountId,
      entry: {
        entityId: bankAccount.entityId,
        status: "POSTED",
        documentDate: { gte: dateMin, lte: dateMax },
      },
      ...(wantDebit
        ? {
            debit: { gte: amountMin.toFixed(4), lte: amountMax.toFixed(4) },
            credit: { equals: "0" },
          }
        : {
            credit: { gte: amountMin.toFixed(4), lte: amountMax.toFixed(4) },
            debit: { equals: "0" },
          }),
      reconciliationMatches: {
        none: { status: "APPROVED" },
      },
    },
    select: {
      id: true,
      debit: true,
      credit: true,
      description: true,
      entry: { select: { documentDate: true, memo: true } },
      party: { select: { displayName: true } },
    },
    take: 30,
    orderBy: { entry: { documentDate: "desc" } },
  });

  return lines.map((l) => ({
    journalLineId: l.id,
    jeDebit: new Decimal(l.debit.toString()),
    jeCredit: new Decimal(l.credit.toString()),
    jeDate: l.entry.documentDate,
    jeMemo: l.description ?? l.entry.memo,
    jePartyDisplayName: l.party?.displayName,
  }));
}
