// Multi-line adjustment validator. Pure functions, no DB.
//
// The single-counter adjustment (cash + one offsetting line) handles
// the common cases — bank fee, deposit slip, refund. But real-world
// reconciliations regularly need more lines:
//
//   - Net deposit: $97.50 lands in cash, representing $100 from customer
//     minus $2.50 processing fee.
//       DR Cash         97.50
//       DR Bank fees     2.50
//       CR AR — customer 100.00
//
//   - Split payroll: $1,500 withdrawn covers $1,200 gross wages + $300
//     payroll tax remittance.
//       CR Cash             1,500
//       DR Wage expense     1,200
//       DR Payroll tax exp    300
//
//   - Bundled vendor wire: $5,000 paid covers two invoices.
//       CR Cash         5,000
//       DR AP — Vendor  3,200
//       DR AP — Vendor  1,800
//
// In all cases the cash line is FIXED by the bank statement — recon
// computes it from the bank line's signed amount. The operator
// supplies the remaining lines. The invariant the validator enforces:
// Σ debits = Σ credits across the whole JE (the foundational
// double-entry rule).
//
// Sign convention reminders:
//   - Bank deposit (+amount) → cash is DEBIT side
//   - Bank withdrawal (-amount) → cash is CREDIT side
//   - User-provided lines can take either side; the validator only
//     cares about Σ DR = Σ CR

import { Decimal } from "decimal.js";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export type LineSide = "DEBIT" | "CREDIT";

export interface UserAdjustmentLine {
  accountCode: string;
  side: LineSide;
  /** Positive amount; side specifies whether this is DR or CR. */
  amount: Decimal | string | number;
  partyCode?: string | null;
  description?: string | null;
}

export interface AdjustmentLineForBridge {
  accountCode: string;
  /** Set to a positive Decimal when this line is a debit. */
  debit?: Decimal;
  /** Set to a positive Decimal when this line is a credit. */
  credit?: Decimal;
  partyCode?: string;
  description?: string;
}

export class AdjustmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdjustmentValidationError";
  }
}

function toDecimal(v: Decimal | string | number): Decimal {
  return v instanceof Decimal ? v : new Decimal(v);
}

function round2(d: Decimal): Decimal {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
}

/**
 * Compute the cash line for a bank-line adjustment. Sign convention
 * matches the existing single-counter adjustment: deposit → cash
 * debit; withdrawal → cash credit. Refuses $0 bank lines (they don't
 * need adjusting).
 */
export function buildCashLine(input: {
  cashAccountCode: string;
  bankLineAmount: Decimal | string | number;
}): AdjustmentLineForBridge {
  const signed = toDecimal(input.bankLineAmount);
  if (signed.isZero()) {
    throw new AdjustmentValidationError("Cannot post a $0 adjustment");
  }
  const abs = round2(signed.abs());
  // Sub-penny defense for the cash line (mirror of the counter-line
  // check). A bank line of $0.001 passes !isZero() above, then rounds
  // to $0.00. Without this check the operator would see a downstream
  // Σ DR = Σ CR balance error rather than a specific cash-line error.
  if (abs.isZero()) {
    throw new AdjustmentValidationError(
      `Bank line amount ${signed.toFixed(4)} rounds to $0.00 at 2-decimal precision. Sub-penny bank amounts are not supported.`
    );
  }
  return signed.isPositive()
    ? { accountCode: input.cashAccountCode, debit: abs }
    : { accountCode: input.cashAccountCode, credit: abs };
}

/**
 * Validate user-supplied counter lines + combine with the cash line.
 * Returns the array of lines ready to hand to the ledger-core bridge.
 *
 * Rules enforced:
 *   - At least one counter line required.
 *   - Every line must have a non-empty account code.
 *   - Every amount must be a positive number > 0.
 *   - Σ DR = Σ CR across cash line + counter lines (penny-perfect
 *     after 2dp rounding).
 *
 * The validator does NOT enforce that the cash line's side and the
 * counter lines' sides are opposite — multi-line adjustments
 * legitimately have lines on the same side as cash (e.g., bank fee
 * sitting alongside cash on the debit side of a deposit JE).
 */
export interface ValidateAdjustmentInput {
  cashAccountCode: string;
  bankLineAmount: Decimal | string | number;
  counterLines: UserAdjustmentLine[];
}

export interface ValidateAdjustmentResult {
  /** All lines in the order they'll be posted; cash is always lineNo=1. */
  lines: AdjustmentLineForBridge[];
  /** Total DR side (cash + counter), rounded to 2dp. */
  totalDebits: Decimal;
  /** Total CR side (cash + counter), rounded to 2dp. */
  totalCredits: Decimal;
}

export function validateAdjustment(
  input: ValidateAdjustmentInput
): ValidateAdjustmentResult {
  if (!input.counterLines || input.counterLines.length === 0) {
    throw new AdjustmentValidationError(
      "At least one counter line is required (in addition to the cash line)"
    );
  }

  const cashLine = buildCashLine({
    cashAccountCode: input.cashAccountCode,
    bankLineAmount: input.bankLineAmount,
  });

  const counterForBridge: AdjustmentLineForBridge[] = [];
  let totalDebits = cashLine.debit ?? new Decimal(0);
  let totalCredits = cashLine.credit ?? new Decimal(0);

  for (let i = 0; i < input.counterLines.length; i += 1) {
    const u = input.counterLines[i];
    if (!u.accountCode || u.accountCode.trim().length === 0) {
      throw new AdjustmentValidationError(
        `Line ${i + 2}: account code is required`
      );
    }
    const amt = toDecimal(u.amount);
    if (amt.isNegative() || amt.isZero()) {
      throw new AdjustmentValidationError(
        `Line ${i + 2} (${u.accountCode}): amount must be greater than 0 (got ${amt.toFixed(2)})`
      );
    }
    if (u.side !== "DEBIT" && u.side !== "CREDIT") {
      throw new AdjustmentValidationError(
        `Line ${i + 2} (${u.accountCode}): side must be DEBIT or CREDIT`
      );
    }
    const roundedAmt = round2(amt);
    // Sub-penny defense: an operator-entered $0.001 line passes the
    // !isZero() check above on its unrounded value, then rounds to
    // $0.00 here. Without this guard the line silently contributes
    // nothing to either DR or CR totals while the JE looks balanced —
    // the operator's intent is erased without an error. Reject
    // explicitly so the operator sees what happened.
    if (roundedAmt.isZero()) {
      throw new AdjustmentValidationError(
        `Line ${i + 2} (${u.accountCode}): amount ${amt.toFixed(4)} rounds to $0.00 at 2-decimal precision. Sub-penny lines are not supported — enter at least $0.01.`
      );
    }
    if (u.side === "DEBIT") {
      totalDebits = totalDebits.plus(roundedAmt);
      counterForBridge.push({
        accountCode: u.accountCode.trim(),
        debit: roundedAmt,
        partyCode: u.partyCode?.trim() || undefined,
        description: u.description?.trim() || undefined,
      });
    } else {
      totalCredits = totalCredits.plus(roundedAmt);
      counterForBridge.push({
        accountCode: u.accountCode.trim(),
        credit: roundedAmt,
        partyCode: u.partyCode?.trim() || undefined,
        description: u.description?.trim() || undefined,
      });
    }
  }

  // Penny-perfect balance check. After rounding each line to 2dp the
  // sums must tie exactly — JE posting in ledger-core will reject
  // anything else. We do the check here so the operator sees the
  // mismatch in the UI before round-tripping.
  if (!totalDebits.equals(totalCredits)) {
    const diff = totalDebits.minus(totalCredits);
    const direction = diff.isPositive() ? "exceeds" : "falls short of";
    throw new AdjustmentValidationError(
      `Debits ${direction} credits by ${diff.abs().toFixed(2)} — Σ DR (${totalDebits.toFixed(2)}) must equal Σ CR (${totalCredits.toFixed(2)})`
    );
  }

  return {
    lines: [cashLine, ...counterForBridge],
    totalDebits: round2(totalDebits),
    totalCredits: round2(totalCredits),
  };
}

/**
 * Convenience: compute the running balance delta without throwing.
 * The UI calls this on every keystroke so it can show "need $X more
 * on the DR side" before the operator hits submit.
 *
 * Returns positive = DR exceeds CR; negative = CR exceeds DR; zero = balanced.
 * Lines with invalid amounts contribute zero (the UI surfaces the
 * row-level error separately).
 */
export function computeRunningImbalance(input: {
  cashAccountCode: string;
  bankLineAmount: Decimal | string | number;
  counterLines: UserAdjustmentLine[];
}): { imbalance: Decimal; totalDebits: Decimal; totalCredits: Decimal } {
  let totalDebits: Decimal;
  let totalCredits: Decimal;
  try {
    const cash = buildCashLine({
      cashAccountCode: input.cashAccountCode,
      bankLineAmount: input.bankLineAmount,
    });
    totalDebits = cash.debit ?? new Decimal(0);
    totalCredits = cash.credit ?? new Decimal(0);
  } catch {
    totalDebits = new Decimal(0);
    totalCredits = new Decimal(0);
  }
  for (const u of input.counterLines) {
    let amt: Decimal;
    try {
      amt = toDecimal(u.amount);
    } catch {
      continue;
    }
    if (amt.isNegative() || amt.isZero() || !amt.isFinite()) continue;
    const rounded = round2(amt);
    if (u.side === "DEBIT") totalDebits = totalDebits.plus(rounded);
    else if (u.side === "CREDIT") totalCredits = totalCredits.plus(rounded);
  }
  return {
    imbalance: round2(totalDebits.minus(totalCredits)),
    totalDebits: round2(totalDebits),
    totalCredits: round2(totalCredits),
  };
}
