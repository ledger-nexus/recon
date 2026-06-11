// Unit tests for the NS recon import orchestrator.
//
// Mocks Prisma so the suite runs without a live DB. Integration tests
// against real Postgres land alongside the Server Action in a
// follow-up PR.

import { describe, it, expect, vi } from "vitest";
import { importFromNsRecon } from "../src/lib/mappers/netsuite";
import type {
  NsBankAccount,
  NsBankStatement,
  NsBankStatementLine,
  NsReconExport,
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
    gl_account_id: { internalid: "acct-1000" },
    subsidiary: { internalid: "sub-1" },
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
    description: "ACH",
    amount: 1000,
    ...overrides,
  };
}

function makeStatement(
  overrides: Partial<NsBankStatement> = {}
): NsBankStatement {
  return {
    internalid: "stmt-500",
    bank_account: { internalid: "ba-100" },
    period_start: "2026-03-01",
    period_end: "2026-03-31",
    opening_balance: 0,
    closing_balance: 1000,
    currency: "USD",
    lines: [makeLine()],
    ...overrides,
  };
}

function makeExport(
  overrides: Partial<NsReconExport> = {}
): NsReconExport {
  return {
    exported_at: "2026-06-05T00:00:00Z",
    account_id: "ns-acct-1",
    bank_accounts: [makeBankAccount()],
    statements: [makeStatement()],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mocked Prisma
// ─────────────────────────────────────────────────────────────────────────────

interface MockState {
  existingStatements: Map<string, string>; // filename → id
  createdStatementCount: number;
  createdMatchCount: number;
  capturedStatementData: unknown[];
  capturedMatchData: unknown[];
}

function makeMockPrisma(initial: Partial<MockState> = {}): {
  prisma: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  state: MockState;
} {
  const state: MockState = {
    existingStatements: new Map(initial.existingStatements ?? []),
    createdStatementCount: 0,
    createdMatchCount: 0,
    capturedStatementData: [],
    capturedMatchData: [],
  };

  const makeTxClient = () => ({
    bankStatement: {
      create: vi.fn(async ({ data }: { data: { filename: string; lines?: { create: unknown[] } } }) => {
        state.createdStatementCount += 1;
        const id = `stmt-${state.createdStatementCount}`;
        state.existingStatements.set(data.filename, id);
        state.capturedStatementData.push(data);
        const linesCreated = (data.lines?.create as Array<{ lineNo: number }>) ?? [];
        return {
          id,
          lines: linesCreated.map((l, idx) => ({
            id: `line-${state.createdStatementCount}-${idx}`,
            lineNo: l.lineNo,
          })),
        };
      }),
    },
    reconciliationMatch: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        state.createdMatchCount += 1;
        state.capturedMatchData.push(data);
        return { id: `rm-${state.createdMatchCount}` };
      }),
    },
  });

  const prisma = {
    bankAccount: {
      upsert: vi.fn(async ({ where }: { where: { code: string } }) => ({
        id: `bank-account-${where.code}`,
      })),
    },
    bankStatement: {
      findFirst: vi.fn(async ({ where }: { where: { filename: string } }) => {
        const id = state.existingStatements.get(where.filename);
        return id ? { id } : null;
      }),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(makeTxClient())),
  };

  return { prisma, state };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("importFromNsRecon — orchestrator", () => {
  it("happy path — single statement, no pre-existing matches", async () => {
    const { prisma, state } = makeMockPrisma();
    const result = await importFromNsRecon(prisma, {
      export: makeExport(),
      resolveEntityId: async () => "entity-1",
      resolveBankGlAccountId: async () => "gl-account-1",
      resolveJournalLineId: async () => null,
    });

    expect(result.totals.statementsCreated).toBe(1);
    expect(result.totals.linesCreated).toBe(1);
    expect(result.totals.matchesCreated).toBe(0);
    expect(result.totals.statementsErrored).toBe(0);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0].wasDuplicate).toBe(false);
    expect(state.createdMatchCount).toBe(0);
  });

  it("SKIPS statement when filename already exists (idempotency)", async () => {
    const { prisma, state } = makeMockPrisma({
      existingStatements: new Map([["ns-stmt-500.json", "stmt-existing"]]),
    });
    const result = await importFromNsRecon(prisma, {
      export: makeExport(),
      resolveEntityId: async () => "entity-1",
      resolveBankGlAccountId: async () => "gl-account-1",
      resolveJournalLineId: async () => null,
    });

    expect(result.totals.statementsCreated).toBe(0);
    expect(result.totals.statementsSkipped).toBe(1);
    expect(result.statements[0].wasDuplicate).toBe(true);
    expect(result.statements[0].bankStatementId).toBe("stmt-existing");
    expect(state.createdStatementCount).toBe(0);
  });

  it("creates a MANUAL/APPROVED ReconciliationMatch for each resolved pre-existing match", async () => {
    const { prisma, state } = makeMockPrisma();
    const result = await importFromNsRecon(prisma, {
      export: makeExport({
        statements: [
          makeStatement({
            opening_balance: 0,
            closing_balance: 2000,
            lines: [
              makeLine({
                internalid: "ln-1",
                line_no: 1,
                amount: 1000,
                matched_transaction_type: "payment",
                matched_transaction_id: "pay-1",
              }),
              makeLine({
                internalid: "ln-2",
                line_no: 2,
                amount: 1000,
                matched_transaction_type: "bill_payment",
                matched_transaction_id: "bp-1",
              }),
            ],
          }),
        ],
      }),
      resolveEntityId: async () => "entity-1",
      resolveBankGlAccountId: async () => "gl-account-1",
      resolveJournalLineId: async ({ matchedTransactionInternalId }) =>
        `je-line-${matchedTransactionInternalId}`,
    });

    expect(result.totals.linesCreated).toBe(2);
    expect(result.totals.matchesCreated).toBe(2);
    expect(result.totals.matchesSkipped).toBe(0);
    expect(state.capturedMatchData).toHaveLength(2);
    const first = state.capturedMatchData[0] as { source: string; status: string; journalLineId: string };
    expect(first.source).toBe("MANUAL");
    expect(first.status).toBe("APPROVED");
    expect(first.journalLineId).toBe("je-line-pay-1");
  });

  it("SKIPS a match when resolver returns null (GL document not yet imported)", async () => {
    const { prisma, state } = makeMockPrisma();
    const result = await importFromNsRecon(prisma, {
      export: makeExport({
        statements: [
          makeStatement({
            opening_balance: 0,
            closing_balance: 1000,
            lines: [
              makeLine({
                matched_transaction_type: "payment",
                matched_transaction_id: "pay-not-yet-imported",
              }),
            ],
          }),
        ],
      }),
      resolveEntityId: async () => "entity-1",
      resolveBankGlAccountId: async () => "gl-account-1",
      // Resolver always returns null — match cannot be resolved.
      resolveJournalLineId: async () => null,
    });

    expect(result.totals.linesCreated).toBe(1); // line still landed
    expect(result.totals.matchesCreated).toBe(0); // but no match created
    expect(result.totals.matchesSkipped).toBe(1);
    expect(state.createdMatchCount).toBe(0);
    const warnings = result.statements[0].warnings;
    expect(warnings.some((w) => w.includes("could not resolve payment pay-not-yet-imported"))).toBe(true);
  });

  it("isolates per-statement failures (missing entity bootstrapping)", async () => {
    const { prisma } = makeMockPrisma();
    const result = await importFromNsRecon(prisma, {
      export: makeExport({
        statements: [
          makeStatement({ internalid: "stmt-good" }),
          makeStatement({
            internalid: "stmt-bad",
            bank_account: { internalid: "ba-100" },
          }),
        ],
      }),
      resolveEntityId: async () => "", // empty → throw for all
      resolveBankGlAccountId: async () => "gl-account-1",
      resolveJournalLineId: async () => null,
    });

    expect(result.totals.statementsCreated).toBe(0);
    expect(result.totals.statementsErrored).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].message).toMatch(/LegalEntity/);
  });

  it("throws per-statement when GL account resolver returns empty", async () => {
    const { prisma } = makeMockPrisma();
    const result = await importFromNsRecon(prisma, {
      export: makeExport(),
      resolveEntityId: async () => "entity-1",
      resolveBankGlAccountId: async () => "",
      resolveJournalLineId: async () => null,
    });

    expect(result.totals.statementsErrored).toBe(1);
    expect(result.errors[0].message).toMatch(/bank GL Account/);
  });

  it("throws per-statement when statement references a bank account NOT in the bundle", async () => {
    const { prisma } = makeMockPrisma();
    const result = await importFromNsRecon(prisma, {
      export: makeExport({
        bank_accounts: [makeBankAccount({ internalid: "ba-100" })],
        statements: [
          makeStatement({ bank_account: { internalid: "ba-MISSING" } }),
        ],
      }),
      resolveEntityId: async () => "entity-1",
      resolveBankGlAccountId: async () => "gl-account-1",
      resolveJournalLineId: async () => null,
    });

    expect(result.totals.statementsErrored).toBe(1);
    expect(result.errors[0].message).toMatch(/ba-MISSING/);
    expect(result.errors[0].message).toMatch(/not in the export bundle/);
  });

  it("counts mixed-result totals correctly", async () => {
    const { prisma } = makeMockPrisma({
      existingStatements: new Map([["ns-stmt-dup.json", "stmt-existing"]]),
    });
    const result = await importFromNsRecon(prisma, {
      export: makeExport({
        statements: [
          makeStatement({ internalid: "stmt-new-1" }),
          makeStatement({ internalid: "stmt-dup" }),
          makeStatement({
            internalid: "stmt-err",
            bank_account: { internalid: "missing-ba" },
          }),
          makeStatement({ internalid: "stmt-new-2" }),
        ],
      }),
      resolveEntityId: async () => "entity-1",
      resolveBankGlAccountId: async () => "gl-account-1",
      resolveJournalLineId: async () => null,
    });

    expect(result.totals.statementsProcessed).toBe(4);
    expect(result.totals.statementsCreated).toBe(2);
    expect(result.totals.statementsSkipped).toBe(1);
    expect(result.totals.statementsErrored).toBe(1);
  });

  it("writes BankStatementLine.status=MATCHED for matched lines, UNMATCHED for others", async () => {
    const { prisma, state } = makeMockPrisma();
    await importFromNsRecon(prisma, {
      export: makeExport({
        statements: [
          makeStatement({
            opening_balance: 0,
            closing_balance: 2000,
            lines: [
              makeLine({ internalid: "ln-matched", line_no: 1, amount: 1000, matched_transaction_type: "payment", matched_transaction_id: "pay-1" }),
              makeLine({ internalid: "ln-unmatched", line_no: 2, amount: 1000 }),
            ],
          }),
        ],
      }),
      resolveEntityId: async () => "entity-1",
      resolveBankGlAccountId: async () => "gl-account-1",
      resolveJournalLineId: async () => "je-line-1",
    });

    const stmt = state.capturedStatementData[0] as {
      lines: { create: Array<{ status: string; lineNo: number }> };
      matchedLines: number;
      pendingLines: number;
      totalLines: number;
    };
    expect(stmt.totalLines).toBe(2);
    expect(stmt.matchedLines).toBe(1);
    expect(stmt.pendingLines).toBe(1);
    const linesCreate = stmt.lines.create;
    expect(linesCreate[0].status).toBe("MATCHED");
    expect(linesCreate[1].status).toBe("UNMATCHED");
  });

  it("propagates mapper warnings (e.g., balance mismatch)", async () => {
    const { prisma } = makeMockPrisma();
    const result = await importFromNsRecon(prisma, {
      export: makeExport({
        statements: [
          makeStatement({
            opening_balance: 0,
            closing_balance: 5000, // declared
            lines: [makeLine({ amount: 1000 })], // actual sum = 1000
          }),
        ],
      }),
      resolveEntityId: async () => "entity-1",
      resolveBankGlAccountId: async () => "gl-account-1",
      resolveJournalLineId: async () => null,
    });

    expect(result.statements[0].warnings.some((w) => w.includes("does not match closing"))).toBe(true);
    expect(result.totals.warningCount).toBeGreaterThan(0);
  });
});
