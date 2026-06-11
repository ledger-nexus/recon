// Integration test for the recon NS REVERSE EXPORTER.
//
// Proves the universal-schema "validate by mapping" thesis end-to-end
// for recon's bank-reconciliation domain — mirrors the just-shipped
// revenue-rec roundtrip-proof test.
//
//   1. Import an NS bundle (importFromNsRecon) — writes BankAccount +
//      BankStatement + BankStatementLine + (when GL doc resolvable)
//      ReconciliationMatch rows.
//   2. Re-export (exportToNsRecon) — reads BankStatement.rawPayload
//      back and reconstructs BankAccount entries from
//      BankAccount.code = "NS-BANK-{internalid}".
//   3. Diff against the original (diffNsReconExports).
//   4. Assert the diff is empty under documented exemptions
//      (exported_at + reconciliations[] not included today).
//
// Tenant scoping: the export filter is
// `bankAccount: { entity: { tenantId } }` — statements imported
// under a different tenant must NOT appear.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  exportToNsRecon,
  importFromNsRecon,
  diffNsReconExports,
} from "../src/lib/mappers/netsuite";
import type {
  NsBankStatement,
  NsBankAccount,
  NsReconExport,
} from "../src/lib/mappers/netsuite";

const HAS_DB = !!process.env.DATABASE_URL;

const prisma = new PrismaClient();
const SUFFIX = "rxprt" + Date.now().toString(36);

let entityId: string;
let bankGlAccountId: string;
let realJournalLineId: string;

async function cleanup() {
  await prisma.bankStatement.deleteMany({
    where: { filename: { startsWith: `ns-RXPRT-${SUFFIX}` } },
  });
  await prisma.bankAccount.deleteMany({
    where: { code: { startsWith: `NS-BANK-RXPRT-${SUFFIX}` } },
  });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  const entity = await prisma.legalEntity.findFirst({
    where: { code: "NORTHWIND" },
    select: { id: true },
  });
  if (!entity) throw new Error("NORTHWIND entity not found.");
  entityId = entity.id;
  const cash = await prisma.account.findFirst({
    where: { code: "1000", OR: [{ entityId: null }, { entityId }] },
    select: { id: true },
  });
  if (!cash) throw new Error("Cash account 1000 not found.");
  bankGlAccountId = cash.id;
  const someLine = await prisma.journalLine.findFirst({ select: { id: true } });
  if (!someLine) throw new Error("No JournalLine in DB.");
  realJournalLineId = someLine.id;
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

function makeBundle(opts: {
  bankAccountInternalId: string;
  statementInternalId: string;
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
        description: "ACH credit",
        amount: 1000,
        matched_transaction_type: "payment",
        matched_transaction_id: "pay-resolvable",
      },
      {
        internalid: `${opts.statementInternalId}-ln-2`,
        line_no: 2,
        transaction_date: "2026-03-20",
        description: "Wire",
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

describe.skipIf(!HAS_DB)("exportToNsRecon — roundtrip proof vs real Postgres", () => {
  it("imports a bundle, re-exports, and diffNsReconExports returns no statement-level differences", async () => {
    const original = makeBundle({
      bankAccountInternalId: `RXPRT-${SUFFIX}-ba1`,
      statementInternalId: `RXPRT-${SUFFIX}-s1`,
    });

    // 1. Import.
    const importResult = await importFromNsRecon(prisma, {
      export: original,
      resolveEntityId: async () => entityId,
      resolveBankGlAccountId: async () => bankGlAccountId,
      resolveJournalLineId: async () => realJournalLineId,
    });
    expect(importResult.totals.statementsCreated).toBe(1);
    expect(importResult.errors).toHaveLength(0);

    // 2. Re-export scoped to this tenant.
    const tenantForExport = await prisma.legalEntity.findFirstOrThrow({
      where: { id: entityId },
      select: { tenantId: true },
    });
    const exportResult = await exportToNsRecon(prisma, {
      tenantId: tenantForExport.tenantId,
    });
    expect(exportResult.statementCount).toBeGreaterThanOrEqual(1);

    // 3. Find our specific statement in the re-export.
    const reExportedStmt = exportResult.bundle.statements.find(
      (s) => s.internalid === `RXPRT-${SUFFIX}-s1`
    );
    expect(reExportedStmt).toBeDefined();

    // 4. Focused diff.
    const focused: NsReconExport = {
      ...exportResult.bundle,
      statements: [reExportedStmt!],
      bank_accounts: exportResult.bundle.bank_accounts.filter(
        (b) => b.internalid === `RXPRT-${SUFFIX}-ba1`
      ),
    };
    const diffs = diffNsReconExports(original, focused);
    // Statement-level should be 0. Bank-account level may show (unresolved)
    // entries — that's documented when the GL Account or Subsidiary
    // weren't bootstrapped via NS. The dev DB's account 1000 doesn't
    // have NS lineage, so this is expected.
    const statementDiffs = diffs.filter((d) => d.startsWith("statement"));
    expect(statementDiffs).toEqual([]);
  });

  it("preserves matched_transaction fields through the roundtrip", async () => {
    const original = makeBundle({
      bankAccountInternalId: `RXPRT-${SUFFIX}-ba2`,
      statementInternalId: `RXPRT-${SUFFIX}-s2`,
    });
    await importFromNsRecon(prisma, {
      export: original,
      resolveEntityId: async () => entityId,
      resolveBankGlAccountId: async () => bankGlAccountId,
      resolveJournalLineId: async () => realJournalLineId,
    });

    const tenant = await prisma.legalEntity.findFirstOrThrow({
      where: { id: entityId },
      select: { tenantId: true },
    });
    const result = await exportToNsRecon(prisma, { tenantId: tenant.tenantId });
    const reExportedStmt = result.bundle.statements.find(
      (s) => s.internalid === `RXPRT-${SUFFIX}-s2`
    );
    expect(reExportedStmt).toBeDefined();

    // The matched line should have its matched_transaction_id + type preserved.
    const matchedLine = reExportedStmt!.lines.find(
      (l) => l.matched_transaction_id === "pay-resolvable"
    );
    expect(matchedLine).toBeDefined();
    expect(matchedLine!.matched_transaction_type).toBe("payment");

    // The unmatched line should have those fields null/undefined.
    const unmatched = reExportedStmt!.lines.find(
      (l) => l.line_no === 2
    );
    expect(unmatched?.matched_transaction_id).toBeFalsy();
  });

  it("returns no rows for a foreign tenant (CC6.1 cross-tenant isolation)", async () => {
    await importFromNsRecon(prisma, {
      export: makeBundle({
        bankAccountInternalId: `RXPRT-${SUFFIX}-ba3`,
        statementInternalId: `RXPRT-${SUFFIX}-s3`,
      }),
      resolveEntityId: async () => entityId,
      resolveBankGlAccountId: async () => bankGlAccountId,
      resolveJournalLineId: async () => realJournalLineId,
    });

    const result = await exportToNsRecon(prisma, {
      tenantId: "99999999-1111-aaaa-bbbb-cccccccccccc",
    });
    const visibleStmtIds = result.bundle.statements.map((s) => s.internalid);
    expect(visibleStmtIds).not.toContain(`RXPRT-${SUFFIX}-s3`);
  });

  it("warns about (unresolved) GL Account references when NS lineage is missing", async () => {
    // The dev DB's account 1000 was seeded without NS lineage
    // (sourceRecordId is null). After import + re-export, the bank
    // account's gl_account_id.internalid should be "(unresolved)" +
    // a warning emitted.
    await importFromNsRecon(prisma, {
      export: makeBundle({
        bankAccountInternalId: `RXPRT-${SUFFIX}-ba4`,
        statementInternalId: `RXPRT-${SUFFIX}-s4`,
      }),
      resolveEntityId: async () => entityId,
      resolveBankGlAccountId: async () => bankGlAccountId,
      resolveJournalLineId: async () => realJournalLineId,
    });

    const tenant = await prisma.legalEntity.findFirstOrThrow({
      where: { id: entityId },
      select: { tenantId: true },
    });
    const result = await exportToNsRecon(prisma, { tenantId: tenant.tenantId });
    const ba = result.bundle.bank_accounts.find(
      (b) => b.internalid === `RXPRT-${SUFFIX}-ba4`
    );
    expect(ba).toBeDefined();
    // We expect "(unresolved)" because NORTHWIND's cash account doesn't
    // have NS lineage in the seed.
    expect(ba?.gl_account_id.internalid).toBe("(unresolved)");
    expect(result.warnings.some((w) => w.includes("gl_account_id"))).toBe(true);
  });

  it("uses input.exportedAt + accountId when provided", async () => {
    const stamp = new Date("2026-12-31T23:59:59.999Z");
    const result = await exportToNsRecon(prisma, {
      tenantId: (
        await prisma.legalEntity.findFirstOrThrow({
          where: { id: entityId },
          select: { tenantId: true },
        })
      ).tenantId,
      exportedAt: stamp,
      accountId: "my-ns-account",
    });
    expect(result.bundle.exported_at).toBe(stamp.toISOString());
    expect(result.bundle.account_id).toBe("my-ns-account");
  });
});
