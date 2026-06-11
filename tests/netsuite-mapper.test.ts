// Unit tests for recon's NetSuite pure mappers.
//
// No DB access; tests run anywhere. Integration tests against real
// Postgres land alongside the orchestrator (PR #2 of the sprint).

import { describe, it, expect } from "vitest";
import {
  mapBankAccount,
  mapForImport,
  mapStatement,
  mapStatementLine,
  NS_RECON_MAPPING_VERSION,
} from "../src/lib/mappers/netsuite";
import type {
  NsBankAccount,
  NsBankStatement,
  NsBankStatementLine,
} from "../src/lib/mappers/netsuite";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

function makeBankAccount(
  overrides: Partial<NsBankAccount> = {}
): NsBankAccount {
  return {
    internalid: "ba-100",
    name: "Chase Operating ****1234",
    gl_account_id: { internalid: "acct-1000", name: "Cash — Chase Operating" },
    subsidiary: { internalid: "sub-1", name: "Acme US" },
    currency: "USD",
    ...overrides,
  };
}

function makeLine(
  overrides: Partial<NsBankStatementLine> = {}
): NsBankStatementLine {
  return {
    internalid: "ln-1",
    line_no: 1,
    transaction_date: "2026-03-15",
    description: "ACH Credit — INITECH PAYMENT",
    amount: 1200.0,
    reconciled: false,
    ...overrides,
  };
}

function makeStatement(
  overrides: Partial<NsBankStatement> = {}
): NsBankStatement {
  return {
    internalid: "stmt-500",
    tranid: "STMT-2026-03",
    bank_account: { internalid: "ba-100", name: "Chase Operating ****1234" },
    period_start: "2026-03-01",
    period_end: "2026-03-31",
    opening_balance: 50000.0,
    closing_balance: 51200.0,
    currency: "USD",
    lines: [makeLine()],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bank account mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("mapBankAccount", () => {
  it("translates an NS bank account to recon's input shape", () => {
    const result = mapBankAccount(makeBankAccount());
    expect(result.code).toBe("NS-BANK-ba-100");
    expect(result.displayName).toBe("Chase Operating ****1234");
    expect(result.nsGlAccountInternalId).toBe("acct-1000");
    expect(result.nsSubsidiaryInternalId).toBe("sub-1");
    expect(result.currency).toBe("USD");
    expect(result.sourceSystem).toBe("netsuite");
    expect(result.sourceRecordType).toBe("BankAccount");
    expect(result.sourceRecordId).toBe("ba-100");
    expect(result.mappingVersion).toBe(NS_RECON_MAPPING_VERSION);
    // sourcePayload is the verbatim NS shape — roundtrip-ready.
    expect(result.sourcePayload.name).toBe("Chase Operating ****1234");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Statement line mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("mapStatementLine", () => {
  it("translates a vanilla unmatched line — no MappedLineMatch returned", () => {
    const { line, match } = mapStatementLine(makeLine());
    expect(line.lineNo).toBe(1);
    expect(line.transactionDate).toBe("2026-03-15");
    expect(line.description).toBe("ACH Credit — INITECH PAYMENT");
    expect(line.amount).toBe(1200);
    expect(line.externalRef).toBe("ln-1"); // falls back to NS internalid
    expect(match).toBeNull();
  });

  it("translates a line WITH matched_transaction_id → MANUAL/APPROVED match", () => {
    const { line, match } = mapStatementLine(
      makeLine({
        matched_transaction_id: "pay-9001",
        matched_transaction_type: "payment",
        reconciled: true,
      })
    );

    expect(line.lineNo).toBe(1);
    expect(match).not.toBeNull();
    expect(match!.bankLineSourceRecordId).toBe("ln-1");
    expect(match!.matchedTransactionType).toBe("payment");
    expect(match!.matchedTransactionInternalId).toBe("pay-9001");
    expect(match!.source).toBe("MANUAL"); // load-bearing translation rule
    expect(match!.status).toBe("APPROVED");
  });

  it("preserves external_ref when set (Plaid txn id case)", () => {
    const { line } = mapStatementLine(
      makeLine({ external_ref: "plaid-txn-abc123" })
    );
    expect(line.externalRef).toBe("plaid-txn-abc123");
  });

  it("returns no match when matched_transaction_type is missing (only id)", () => {
    const { match } = mapStatementLine(
      makeLine({ matched_transaction_id: "pay-1", matched_transaction_type: null })
    );
    expect(match).toBeNull();
  });

  it("returns no match when matched_transaction_id is missing (only type)", () => {
    const { match } = mapStatementLine(
      makeLine({ matched_transaction_type: "payment", matched_transaction_id: null })
    );
    expect(match).toBeNull();
  });

  it("preserves negative amounts (outflow / withdrawal)", () => {
    const { line } = mapStatementLine(
      makeLine({ amount: -500.0, description: "Wire to vendor" })
    );
    expect(line.amount).toBe(-500);
  });

  it("supports all documented matched_transaction_type values", () => {
    const types = [
      "payment",
      "bill_payment",
      "bank_transfer",
      "cash_refund",
      "deposit",
      "journal_entry",
    ] as const;
    for (const t of types) {
      const { match } = mapStatementLine(
        makeLine({ matched_transaction_id: "x", matched_transaction_type: t })
      );
      expect(match?.matchedTransactionType).toBe(t);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full-statement mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("mapStatement", () => {
  it("maps a single-line statement end-to-end", () => {
    const { statement, warnings } = mapStatement(makeStatement());
    expect(statement.format).toBe("NETSUITE_EXPORT");
    expect(statement.filename).toBe("ns-stmt-500.json");
    expect(statement.periodStart).toBe("2026-03-01");
    expect(statement.periodEnd).toBe("2026-03-31");
    expect(statement.openingBalance).toBe(50000);
    expect(statement.closingBalance).toBe(51200);
    expect(statement.lines).toHaveLength(1);
    expect(statement.lineMatches).toHaveLength(0); // no matched_transaction_id
    expect(statement.sourceRecordId).toBe("stmt-500");
    expect(warnings).toHaveLength(0); // balanced statement
  });

  it("maps a multi-line statement with mixed matched/unmatched lines", () => {
    const ns = makeStatement({
      opening_balance: 0,
      closing_balance: 1500,
      lines: [
        makeLine({ internalid: "ln-1", line_no: 1, amount: 1000 }),
        makeLine({
          internalid: "ln-2",
          line_no: 2,
          amount: 500,
          matched_transaction_type: "payment",
          matched_transaction_id: "pay-100",
        }),
      ],
    });
    const { statement, warnings } = mapStatement(ns);
    expect(statement.lines).toHaveLength(2);
    expect(statement.lineMatches).toHaveLength(1);
    expect(statement.lineMatches[0].bankLineSourceRecordId).toBe("ln-2");
    expect(statement.lineMatches[0].matchedTransactionInternalId).toBe("pay-100");
    expect(warnings).toHaveLength(0);
  });

  it("warns when Σ lines != closing - opening (truncation / partial dataset)", () => {
    const ns = makeStatement({
      opening_balance: 0,
      closing_balance: 1500, // declared
      lines: [makeLine({ amount: 1000 })], // actual sum = 1000
    });
    const { warnings } = mapStatement(ns);
    expect(warnings.some((w) => w.includes("does not match closing"))).toBe(true);
    expect(warnings.some((w) => w.includes("partial dataset"))).toBe(true);
  });

  it("absorbs sub-penny rounding in the balance check", () => {
    const ns = makeStatement({
      opening_balance: 0,
      closing_balance: 1000.005, // half-penny off
      lines: [makeLine({ amount: 1000.0 })],
    });
    const { warnings } = mapStatement(ns);
    expect(warnings.some((w) => w.includes("does not match closing"))).toBe(false);
  });

  it("warns when matched-line ratio is below 50% (mostly unmatched statement)", () => {
    const ns = makeStatement({
      opening_balance: 0,
      closing_balance: 3000,
      lines: [
        makeLine({ internalid: "ln-1", line_no: 1, amount: 1000 }), // no match
        makeLine({ internalid: "ln-2", line_no: 2, amount: 1000 }), // no match
        makeLine({
          internalid: "ln-3",
          line_no: 3,
          amount: 1000,
          matched_transaction_type: "payment",
          matched_transaction_id: "pay-1",
        }),
      ],
    });
    const { warnings } = mapStatement(ns);
    expect(warnings.some((w) => w.includes("33%"))).toBe(true);
    expect(warnings.some((w) => w.includes("matcher"))).toBe(true);
  });

  it("does NOT warn for high-match-ratio statements", () => {
    const lines: NsBankStatementLine[] = [];
    for (let i = 0; i < 10; i += 1) {
      lines.push(
        makeLine({
          internalid: `ln-${i}`,
          line_no: i + 1,
          amount: 100,
          matched_transaction_type: "payment",
          matched_transaction_id: `pay-${i}`,
        })
      );
    }
    const ns = makeStatement({
      opening_balance: 0,
      closing_balance: 1000,
      lines,
    });
    const { warnings } = mapStatement(ns);
    expect(warnings).toHaveLength(0);
  });

  it("does NOT warn on the matched-ratio check for empty statements", () => {
    const ns = makeStatement({
      opening_balance: 0,
      closing_balance: 0,
      lines: [],
    });
    const { warnings } = mapStatement(ns);
    expect(warnings).toHaveLength(0);
  });

  it("preserves the full NS statement in sourcePayload (roundtrip-ready)", () => {
    const ns = makeStatement();
    const { statement } = mapStatement(ns);
    expect(statement.sourcePayload).toBe(ns);
    expect(statement.sourcePayload.tranid).toBe("STMT-2026-03");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full-import composition
// ─────────────────────────────────────────────────────────────────────────────

describe("mapForImport", () => {
  it("composes bank account + statement into one result", () => {
    const result = mapForImport(makeBankAccount(), makeStatement());
    expect(result.bankAccount.code).toBe("NS-BANK-ba-100");
    expect(result.statement.sourceRecordId).toBe("stmt-500");
    expect(result.warnings).toHaveLength(0);
  });

  it("throws when statement.bank_account doesn't match the passed bank account", () => {
    expect(() =>
      mapForImport(
        makeBankAccount({ internalid: "ba-100" }),
        makeStatement({
          bank_account: { internalid: "ba-WRONG" },
        })
      )
    ).toThrow(/ba-WRONG/);
  });

  it("propagates statement-level warnings to the result", () => {
    const result = mapForImport(
      makeBankAccount(),
      makeStatement({
        opening_balance: 0,
        closing_balance: 1500, // mismatch
        lines: [makeLine({ amount: 500 })],
      })
    );
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
