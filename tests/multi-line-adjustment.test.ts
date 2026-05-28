// Multi-line adjustment validator tests. Pure functions — no DB.
//
// Covers:
//   - buildCashLine: sign convention (deposit → DR, withdrawal → CR),
//     $0 rejection
//   - validateAdjustment: at-least-one-counter rule, account code
//     required, amount > 0, side enum, Σ DR = Σ CR invariant,
//     party + description carry-through
//   - computeRunningImbalance: graceful with invalid amounts, mirrors
//     validate-time math

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  buildCashLine,
  validateAdjustment,
  computeRunningImbalance,
  AdjustmentValidationError,
} from "../src/lib/matching/multi-line-adjustment";

// ─────────────────────────────────────────────────────────────────────────────
// buildCashLine
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCashLine", () => {
  it("deposit (+amount) → cash on DEBIT side", () => {
    const line = buildCashLine({ cashAccountCode: "1000", bankLineAmount: 1500 });
    expect(line.accountCode).toBe("1000");
    expect(line.debit?.toFixed(2)).toBe("1500.00");
    expect(line.credit).toBeUndefined();
  });

  it("withdrawal (-amount) → cash on CREDIT side", () => {
    const line = buildCashLine({ cashAccountCode: "1000", bankLineAmount: -200 });
    expect(line.credit?.toFixed(2)).toBe("200.00");
    expect(line.debit).toBeUndefined();
  });

  it("rejects $0", () => {
    expect(() =>
      buildCashLine({ cashAccountCode: "1000", bankLineAmount: 0 })
    ).toThrow(AdjustmentValidationError);
  });

  it("rounds the amount to 2dp", () => {
    const line = buildCashLine({
      cashAccountCode: "1000",
      bankLineAmount: new Decimal("1500.005"),
    });
    // ROUND_HALF_EVEN: 1500.005 → 1500.00 (banker's rounding)
    expect(line.debit?.toFixed(2)).toBe("1500.00");
  });

  it("accepts Decimal, string, number inputs", () => {
    expect(
      buildCashLine({ cashAccountCode: "1000", bankLineAmount: "97.50" }).debit?.toFixed(2)
    ).toBe("97.50");
    expect(
      buildCashLine({
        cashAccountCode: "1000",
        bankLineAmount: new Decimal("97.50"),
      }).debit?.toFixed(2)
    ).toBe("97.50");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateAdjustment
// ─────────────────────────────────────────────────────────────────────────────

describe("validateAdjustment — happy paths", () => {
  it("classic two-line: bank fee withdrawal", () => {
    // $50 withdrawn for bank fees:
    //   CR Cash 50
    //   DR Bank fees 50
    const r = validateAdjustment({
      cashAccountCode: "1000",
      bankLineAmount: -50,
      counterLines: [{ accountCode: "6500", side: "DEBIT", amount: 50 }],
    });
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].accountCode).toBe("1000");
    expect(r.lines[0].credit?.toFixed(2)).toBe("50.00");
    expect(r.lines[1].accountCode).toBe("6500");
    expect(r.lines[1].debit?.toFixed(2)).toBe("50.00");
    expect(r.totalDebits.toFixed(2)).toBe("50.00");
    expect(r.totalCredits.toFixed(2)).toBe("50.00");
  });

  it("three-line: net deposit ($100 customer minus $2.50 fee = $97.50)", () => {
    //   DR Cash         97.50
    //   DR Bank fees     2.50
    //   CR AR — customer 100.00
    const r = validateAdjustment({
      cashAccountCode: "1000",
      bankLineAmount: 97.5,
      counterLines: [
        { accountCode: "6500", side: "DEBIT", amount: 2.5 },
        { accountCode: "1200", side: "CREDIT", amount: 100, partyCode: "CUST_A" },
      ],
    });
    expect(r.lines).toHaveLength(3);
    expect(r.totalDebits.toFixed(2)).toBe("100.00");
    expect(r.totalCredits.toFixed(2)).toBe("100.00");
    // Party carries through.
    expect(r.lines[2].partyCode).toBe("CUST_A");
  });

  it("three-line: split payroll withdrawal", () => {
    //   CR Cash           1500
    //   DR Wage expense   1200
    //   DR Payroll tax     300
    const r = validateAdjustment({
      cashAccountCode: "1000",
      bankLineAmount: -1500,
      counterLines: [
        { accountCode: "6000", side: "DEBIT", amount: 1200 },
        { accountCode: "6010", side: "DEBIT", amount: 300 },
      ],
    });
    expect(r.totalDebits.toFixed(2)).toBe("1500.00");
    expect(r.totalCredits.toFixed(2)).toBe("1500.00");
  });

  it("bundled vendor wire splits across two AP rows for the same vendor", () => {
    //   CR Cash       5000
    //   DR AP Vendor  3200 (party V001)
    //   DR AP Vendor  1800 (party V001)
    const r = validateAdjustment({
      cashAccountCode: "1000",
      bankLineAmount: -5000,
      counterLines: [
        { accountCode: "2100", side: "DEBIT", amount: 3200, partyCode: "V001", description: "Invoice 1001" },
        { accountCode: "2100", side: "DEBIT", amount: 1800, partyCode: "V001", description: "Invoice 1002" },
      ],
    });
    expect(r.lines).toHaveLength(3);
    expect(r.lines[1].description).toBe("Invoice 1001");
    expect(r.lines[2].description).toBe("Invoice 1002");
  });
});

describe("validateAdjustment — rejection cases", () => {
  it("rejects when no counter lines are supplied", () => {
    expect(() =>
      validateAdjustment({
        cashAccountCode: "1000",
        bankLineAmount: 100,
        counterLines: [],
      })
    ).toThrow(/At least one counter line/);
  });

  it("rejects an empty account code on a counter line", () => {
    expect(() =>
      validateAdjustment({
        cashAccountCode: "1000",
        bankLineAmount: 100,
        counterLines: [{ accountCode: "  ", side: "CREDIT", amount: 100 }],
      })
    ).toThrow(/account code is required/);
  });

  it("rejects zero or negative amounts on counter lines", () => {
    expect(() =>
      validateAdjustment({
        cashAccountCode: "1000",
        bankLineAmount: 100,
        counterLines: [{ accountCode: "1200", side: "CREDIT", amount: 0 }],
      })
    ).toThrow(/greater than 0/);

    expect(() =>
      validateAdjustment({
        cashAccountCode: "1000",
        bankLineAmount: 100,
        counterLines: [{ accountCode: "1200", side: "CREDIT", amount: -50 }],
      })
    ).toThrow(/greater than 0/);
  });

  it("rejects an unbalanced JE — DR > CR", () => {
    expect(() =>
      validateAdjustment({
        cashAccountCode: "1000",
        bankLineAmount: 100, // DR cash 100
        counterLines: [
          { accountCode: "1200", side: "CREDIT", amount: 80 }, // CR 80
        ],
      })
    ).toThrow(/exceeds credits by 20.00/);
  });

  it("rejects an unbalanced JE — CR > DR", () => {
    expect(() =>
      validateAdjustment({
        cashAccountCode: "1000",
        bankLineAmount: -100, // CR cash 100
        counterLines: [
          { accountCode: "6500", side: "DEBIT", amount: 50 }, // DR 50
        ],
      })
    ).toThrow(/falls short of credits by 50.00/);
  });

  it("rejects $0 bank line", () => {
    expect(() =>
      validateAdjustment({
        cashAccountCode: "1000",
        bankLineAmount: 0,
        counterLines: [{ accountCode: "6500", side: "DEBIT", amount: 0 }],
      })
    ).toThrow(/\$0 adjustment/);
  });
});

describe("validateAdjustment — penny-perfect rounding", () => {
  it("accepts lines that sum exactly at 2dp", () => {
    const r = validateAdjustment({
      cashAccountCode: "1000",
      bankLineAmount: 100,
      counterLines: [
        { accountCode: "A", side: "CREDIT", amount: "33.33" },
        { accountCode: "B", side: "CREDIT", amount: "33.33" },
        { accountCode: "C", side: "CREDIT", amount: "33.34" },
      ],
    });
    expect(r.totalDebits.toFixed(2)).toBe("100.00");
    expect(r.totalCredits.toFixed(2)).toBe("100.00");
  });

  it("rejects when 2dp rounding leaves a residual penny", () => {
    expect(() =>
      validateAdjustment({
        cashAccountCode: "1000",
        bankLineAmount: 100,
        counterLines: [
          { accountCode: "A", side: "CREDIT", amount: "33.33" },
          { accountCode: "B", side: "CREDIT", amount: "33.33" },
          { accountCode: "C", side: "CREDIT", amount: "33.33" },
        ],
      })
    ).toThrow(/exceeds credits by 0.01/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeRunningImbalance (UI helper, never throws)
// ─────────────────────────────────────────────────────────────────────────────

describe("computeRunningImbalance", () => {
  it("returns zero imbalance when balanced", () => {
    const r = computeRunningImbalance({
      cashAccountCode: "1000",
      bankLineAmount: 100,
      counterLines: [{ accountCode: "1200", side: "CREDIT", amount: 100 }],
    });
    expect(r.imbalance.toFixed(2)).toBe("0.00");
  });

  it("returns positive imbalance when DR > CR", () => {
    const r = computeRunningImbalance({
      cashAccountCode: "1000",
      bankLineAmount: 100,
      counterLines: [{ accountCode: "1200", side: "CREDIT", amount: 80 }],
    });
    expect(r.imbalance.toFixed(2)).toBe("20.00");
  });

  it("returns negative imbalance when CR > DR", () => {
    const r = computeRunningImbalance({
      cashAccountCode: "1000",
      bankLineAmount: -100,
      counterLines: [{ accountCode: "6500", side: "DEBIT", amount: 50 }],
    });
    expect(r.imbalance.toFixed(2)).toBe("-50.00");
  });

  it("skips invalid line amounts (UI-typing-in-progress case)", () => {
    const r = computeRunningImbalance({
      cashAccountCode: "1000",
      bankLineAmount: 100,
      counterLines: [
        { accountCode: "1200", side: "CREDIT", amount: 60 },
        { accountCode: "1200", side: "CREDIT", amount: 0 }, // operator typing
        { accountCode: "1200", side: "CREDIT", amount: 40 },
      ],
    });
    expect(r.imbalance.toFixed(2)).toBe("0.00");
  });

  it("doesn't throw on a $0 bank line — UI calls before bankLineAmount is known", () => {
    expect(() =>
      computeRunningImbalance({
        cashAccountCode: "1000",
        bankLineAmount: 0,
        counterLines: [],
      })
    ).not.toThrow();
  });
});
