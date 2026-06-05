// Integration tests for importFromNsRecon against real Postgres.
//
// Proves the orchestrator's runtime path:
//   - BankAccount upsert against the shared DB
//   - BankStatement + BankStatementLine create within a $transaction
//   - Cross-repo lineage-triple lookup (resolveJournalLineId) against
//     a REAL JournalLine row produces a real ReconciliationMatch
//   - Filename-based idempotency works against the real DB
//
// Reuses the NORTHWIND entity + cash account (1000) + any existing
// JournalLine. Cleanup scoped to filename startsWith `ns-NSINT-${SUFFIX}`
// and BankAccount code startsWith `NS-BANK-NSINT-${SUFFIX}`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { importFromNsRecon } from "../src/lib/mappers/netsuite";
import type {
  NsBankAccount,
  NsBankStatement,
  NsReconExport,
} from "../src/lib/mappers/netsuite";

const prisma = new PrismaClient();
const SUFFIX = "rcint" + Date.now().toString(36);

let entityId: string;
let bankGlAccountId: string;
let realJournalLineId: string;

async function cleanup() {
  // ReconciliationMatch cascades from BankStatementLine cascade from
  // BankStatement. BankAccount has no cascade to BankStatement (manual).
  await prisma.bankStatement.deleteMany({
    where: { filename: { startsWith: `ns-NSINT-${SUFFIX}` } },
  });
  await prisma.bankAccount.deleteMany({
    where: { code: { startsWith: `NS-BANK-NSINT-${SUFFIX}` } },
  });
}

beforeAll(async () => {
  await cleanup();

  const entity = await prisma.legalEntity.findFirst({
    where: { code: "NORTHWIND" },
    select: { id: true },
  });
  if (!entity) {
    throw new Error(
      "NORTHWIND entity not found. Run ledger-core's seed first."
    );
  }
  entityId = entity.id;

  // Cash account 1000 is the bank GL account.
  const cash = await prisma.account.findFirst({
    where: {
      code: "1000",
      OR: [{ entityId: null }, { entityId }],
    },
    select: { id: true },
  });
  if (!cash) {
    throw new Error("Cash account 1000 not found.");
  }
  bankGlAccountId = cash.id;

  // Any existing JournalLine — used as the match target.
  const someLine = await prisma.journalLine.findFirst({
    select: { id: true },
  });
  if (!someLine) {
    throw new Error("No JournalLine in DB. Run `pnpm db:seed` first.");
  }
  realJournalLineId = someLine.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

function makeNsExport(opts: {
  bankAccountInternalId: string;
  statementInternalId: string;
  matchedJournalLineMarker?: string;
}): NsReconExport {
  const bankAccount: NsBankAccount = {
    internalid: opts.bankAccountInternalId,
    name: `Test Chase ****${opts.bankAccountInternalId.slice(-4)}`,
    gl_account_id: { internalid: "acct-1000" },
    subsidiary: { internalid: "sub-1" },
    currency: "USD",
  };
  const statement: NsBankStatement = {
    internalid: opts.statementInternalId,
    tranid: `STMT-${opts.statementInternalId}`,
    bank_account: { internalid: opts.bankAccountInternalId },
    period_start: "2026-03-01",
    period_end: "2026-03-31",
    opening_balance: 0,
    closing_balance: 2000,
    currency: "USD",
    lines: [
      {
        internalid: `${opts.statementInternalId}-ln-1`,
        line_no: 1,
        transaction_date: "2026-03-15",
        description: "ACH credit — matched",
        amount: 1000,
        matched_transaction_type: "payment",
        matched_transaction_id: opts.matchedJournalLineMarker ?? "pay-resolvable",
        reconciled: true,
      },
      {
        internalid: `${opts.statementInternalId}-ln-2`,
        line_no: 2,
        transaction_date: "2026-03-20",
        description: "Wire — unmatched",
        amount: 1000,
      },
    ],
  };
  return {
    exported_at: "2026-06-05T00:00:00Z",
    account_id: "ns-acct-1",
    bank_accounts: [bankAccount],
    statements: [statement],
  };
}

describe("importFromNsRecon — integration vs real Postgres", () => {
  it("creates BankAccount + BankStatement + lines + a MANUAL/APPROVED match end-to-end", async () => {
    const result = await importFromNsRecon(prisma, {
      export: makeNsExport({
        bankAccountInternalId: `NSINT-${SUFFIX}-ba1`,
        statementInternalId: `NSINT-${SUFFIX}-s1`,
      }),
      resolveEntityId: async () => entityId,
      resolveBankGlAccountId: async () => bankGlAccountId,
      // Resolve the matched_transaction_id to the seeded JournalLine.
      resolveJournalLineId: async ({ matchedTransactionInternalId }) =>
        matchedTransactionInternalId === "pay-resolvable"
          ? realJournalLineId
          : null,
    });

    expect(result.totals.statementsCreated).toBe(1);
    expect(result.totals.linesCreated).toBe(2);
    expect(result.totals.matchesCreated).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify the bank statement row landed with correct counters.
    const stmtId = result.statements[0].bankStatementId;
    const stmt = await prisma.bankStatement.findUniqueOrThrow({
      where: { id: stmtId },
      include: { lines: true },
    });
    expect(stmt.totalLines).toBe(2);
    expect(stmt.matchedLines).toBe(1);
    expect(stmt.pendingLines).toBe(1);

    // Verify the MANUAL/APPROVED match row landed.
    const matches = await prisma.reconciliationMatch.findMany({
      where: { bankLineId: { in: stmt.lines.map((l) => l.id) } },
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe("MANUAL");
    expect(matches[0].status).toBe("APPROVED");
    expect(matches[0].journalLineId).toBe(realJournalLineId);
    expect(matches[0].approvedAt).not.toBeNull();
  });

  it("is idempotent — second import of same bundle returns wasDuplicate", async () => {
    const bundle = makeNsExport({
      bankAccountInternalId: `NSINT-${SUFFIX}-ba2`,
      statementInternalId: `NSINT-${SUFFIX}-s2`,
    });

    const first = await importFromNsRecon(prisma, {
      export: bundle,
      resolveEntityId: async () => entityId,
      resolveBankGlAccountId: async () => bankGlAccountId,
      resolveJournalLineId: async () => realJournalLineId,
    });
    expect(first.statements[0].wasDuplicate).toBe(false);

    const second = await importFromNsRecon(prisma, {
      export: bundle,
      resolveEntityId: async () => entityId,
      resolveBankGlAccountId: async () => bankGlAccountId,
      resolveJournalLineId: async () => realJournalLineId,
    });
    expect(second.statements[0].wasDuplicate).toBe(true);
    expect(second.totals.statementsCreated).toBe(0);
    expect(second.totals.statementsSkipped).toBe(1);
    // BankStatementId stable across runs.
    expect(second.statements[0].bankStatementId).toBe(first.statements[0].bankStatementId);
  });

  it("gracefully degrades when resolver returns null — line lands without match", async () => {
    const result = await importFromNsRecon(prisma, {
      export: makeNsExport({
        bankAccountInternalId: `NSINT-${SUFFIX}-ba3`,
        statementInternalId: `NSINT-${SUFFIX}-s3`,
        matchedJournalLineMarker: "pay-not-in-gl-yet",
      }),
      resolveEntityId: async () => entityId,
      resolveBankGlAccountId: async () => bankGlAccountId,
      // GL document not yet imported → resolver returns null.
      resolveJournalLineId: async () => null,
    });

    expect(result.totals.statementsCreated).toBe(1);
    expect(result.totals.linesCreated).toBe(2);
    expect(result.totals.matchesCreated).toBe(0); // skipped
    expect(result.totals.matchesSkipped).toBe(1);
    expect(result.statements[0].warnings.some((w) => w.includes("could not resolve"))).toBe(true);

    // Verify the bank line still landed (UNMATCHED status).
    const stmtId = result.statements[0].bankStatementId;
    const lines = await prisma.bankStatementLine.findMany({
      where: { statementId: stmtId },
    });
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l.status).toBe("UNMATCHED");
    }
    // No ReconciliationMatch rows created.
    const matches = await prisma.reconciliationMatch.findMany({
      where: { bankLineId: { in: lines.map((l) => l.id) } },
    });
    expect(matches).toHaveLength(0);
  });

  it("BankAccount upsert returns the same id on repeat for the same code (no duplicate accounts)", async () => {
    const bundle = makeNsExport({
      bankAccountInternalId: `NSINT-${SUFFIX}-ba4`,
      statementInternalId: `NSINT-${SUFFIX}-s4a`,
    });

    await importFromNsRecon(prisma, {
      export: bundle,
      resolveEntityId: async () => entityId,
      resolveBankGlAccountId: async () => bankGlAccountId,
      resolveJournalLineId: async () => realJournalLineId,
    });

    // Now do another import of a different statement on the same bank account.
    bundle.statements[0].internalid = `NSINT-${SUFFIX}-s4b`;
    bundle.statements[0].lines = bundle.statements[0].lines.map((l) => ({
      ...l,
      internalid: `${bundle.statements[0].internalid}-${l.line_no}`,
    }));

    await importFromNsRecon(prisma, {
      export: bundle,
      resolveEntityId: async () => entityId,
      resolveBankGlAccountId: async () => bankGlAccountId,
      resolveJournalLineId: async () => realJournalLineId,
    });

    // Verify only ONE BankAccount with this code.
    const accounts = await prisma.bankAccount.findMany({
      where: { code: `NS-BANK-NSINT-${SUFFIX}-ba4` },
    });
    expect(accounts).toHaveLength(1);
  });
});
