// Integration tests for reconAttribution against real Postgres.
//
// Spins up a throwaway BankStatement + BankStatementLine + ReconciliationMatch
// fixture, exercises the attribution counts, asserts cross-subject
// isolation, then tears down by created-by sentinel.
//
// Reuses the NORTHWIND entity + cash account + any existing JournalLine
// (any JournalLine works for the match FK — the test isn't asserting
// anything about the JE side). If NORTHWIND isn't seeded, the test
// errors out with an actionable message.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, MatchSource, MatchStatus } from "@prisma/client";

const HAS_DB = !!process.env.DATABASE_URL;

const prisma = new PrismaClient();

// Sentinel UUIDs for the two test subjects. Stable across runs so
// cleanup works even after a prior crash.
const TEST_SUBJECT_ID = "33333333-aaaa-bbbb-cccc-dddddddd0001";
const OTHER_SUBJECT_ID = "44444444-aaaa-bbbb-cccc-dddddddd0002";

// Suffix every row's natural key with this so the cleanup query matches.
const SUFFIX = "dsr" + Date.now().toString(36);

let bankAccountId: string;
let journalLineId: string;

async function cleanup() {
  // Matches → BankStatementLines → BankStatement → BankAccount.
  // FKs use ON DELETE CASCADE for bankLine → matches, so deleting the
  // statement cascades. The throwaway BankAccount is scoped by its
  // suffixed code.
  await prisma.bankStatement.deleteMany({
    where: { filename: { startsWith: `dsr-recon-test-${SUFFIX}` } },
  });
  await prisma.bankAccount.deleteMany({
    where: { code: { startsWith: `DSR-RECON-${SUFFIX}` } },
  });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  await cleanup();

  // Reuse the NORTHWIND seed. The test does not own a tenant chain.
  const entity = await prisma.legalEntity.findFirst({
    where: { code: "NORTHWIND" },
    select: { id: true },
  });
  if (!entity) {
    throw new Error(
      "NORTHWIND entity not found. Run `pnpm db:seed` in ledger-core first."
    );
  }
  const cashAccount = await prisma.account.findFirst({
    where: { code: "1000", OR: [{ entityId: null }, { entityId: entity.id }] },
    select: { id: true },
  });
  if (!cashAccount) {
    throw new Error("Cash account (1000) not found in chart of accounts.");
  }

  // Any existing JournalLine is fine — match FKs only need to resolve.
  const someLine = await prisma.journalLine.findFirst({
    select: { id: true },
  });
  if (!someLine) {
    throw new Error("No JournalLine found. Run `pnpm db:seed` in ledger-core.");
  }
  journalLineId = someLine.id;

  const bankAccount = await prisma.bankAccount.create({
    data: {
      entityId: entity.id,
      accountId: cashAccount.id,
      code: `DSR-RECON-${SUFFIX}`,
      displayName: `DSR Recon Test ${SUFFIX}`,
    },
  });
  bankAccountId = bankAccount.id;
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!HAS_DB)("reconAttribution — integration vs real Postgres", () => {
  it("returns empty-but-valid shape for a user with no recon activity", async () => {
    const { reconAttribution } = await import(
      "@/lib/privacy/recon-attribution"
    );
    const result = await reconAttribution(prisma, TEST_SUBJECT_ID);

    expect(result.bankStatementsUploaded).toBe(0);
    expect(result.reconciliationMatchesApproved).toBe(0);
    expect(result.aiSuggestionsAccepted).toBe(0);
    expect(result.aiSuggestionsRejected).toBe(0);
    expect(result.snapshotAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("counts bank statements uploaded by the subject", async () => {
    await prisma.bankStatement.create({
      data: {
        bankAccountId,
        filename: `dsr-recon-test-${SUFFIX}-1.csv`,
        format: "TEST",
        rawPayload: "test fixture",
        periodStart: new Date("2026-01-01"),
        periodEnd: new Date("2026-01-31"),
        openingBalance: "0.0000",
        closingBalance: "0.0000",
        uploadedBy: TEST_SUBJECT_ID,
      },
    });
    await prisma.bankStatement.create({
      data: {
        bankAccountId,
        filename: `dsr-recon-test-${SUFFIX}-2.csv`,
        format: "TEST",
        rawPayload: "test fixture",
        periodStart: new Date("2026-02-01"),
        periodEnd: new Date("2026-02-28"),
        openingBalance: "0.0000",
        closingBalance: "0.0000",
        uploadedBy: TEST_SUBJECT_ID,
      },
    });

    const { reconAttribution } = await import(
      "@/lib/privacy/recon-attribution"
    );
    const result = await reconAttribution(prisma, TEST_SUBJECT_ID);

    expect(result.bankStatementsUploaded).toBe(2);
  });

  it("counts reconciliation matches approved by the subject (and separates AI accepted)", async () => {
    // Make a bank line we can attach matches to.
    const stmt = await prisma.bankStatement.create({
      data: {
        bankAccountId,
        filename: `dsr-recon-test-${SUFFIX}-3-matches.csv`,
        format: "TEST",
        rawPayload: "test fixture",
        periodStart: new Date("2026-03-01"),
        periodEnd: new Date("2026-03-31"),
        openingBalance: "0.0000",
        closingBalance: "0.0000",
        uploadedBy: TEST_SUBJECT_ID,
        lines: {
          create: [
            { lineNo: 1, transactionDate: new Date("2026-03-05"), description: "Test line 1", amount: "100.0000" },
            { lineNo: 2, transactionDate: new Date("2026-03-06"), description: "Test line 2", amount: "200.0000" },
            { lineNo: 3, transactionDate: new Date("2026-03-07"), description: "Test line 3", amount: "300.0000" },
            { lineNo: 4, transactionDate: new Date("2026-03-08"), description: "Test line 4", amount: "400.0000" },
          ],
        },
      },
      include: { lines: true },
    });
    const lines = stmt.lines;

    // One AI match the subject approved → counted in BOTH totals
    // (reconciliationMatchesApproved + aiSuggestionsAccepted).
    await prisma.reconciliationMatch.create({
      data: {
        bankLineId: lines[0].id,
        journalLineId,
        source: MatchSource.AI,
        status: MatchStatus.APPROVED,
        approvedBy: TEST_SUBJECT_ID,
        approvedAt: new Date(),
      },
    });
    // One MANUAL match the subject approved → only in approved total.
    await prisma.reconciliationMatch.create({
      data: {
        bankLineId: lines[1].id,
        journalLineId,
        source: MatchSource.MANUAL,
        status: MatchStatus.APPROVED,
        approvedBy: TEST_SUBJECT_ID,
        approvedAt: new Date(),
      },
    });
    // One PROPOSED-but-not-approved match — not counted.
    await prisma.reconciliationMatch.create({
      data: {
        bankLineId: lines[2].id,
        journalLineId,
        source: MatchSource.AI,
        status: MatchStatus.PROPOSED,
      },
    });
    // One AI match the subject rejected → only in aiSuggestionsRejected.
    await prisma.reconciliationMatch.create({
      data: {
        bankLineId: lines[3].id,
        journalLineId,
        source: MatchSource.AI,
        status: MatchStatus.REJECTED,
        rejectedBy: TEST_SUBJECT_ID,
        rejectedAt: new Date(),
      },
    });

    const { reconAttribution } = await import(
      "@/lib/privacy/recon-attribution"
    );
    const result = await reconAttribution(prisma, TEST_SUBJECT_ID);

    expect(result.bankStatementsUploaded).toBe(3); // 2 from previous test + this one
    expect(result.reconciliationMatchesApproved).toBe(2);
    expect(result.aiSuggestionsAccepted).toBe(1);
    expect(result.aiSuggestionsRejected).toBe(1);
  });

  it("does not leak the other user's activity (cross-subject isolation)", async () => {
    // Create a statement + match owned by OTHER_SUBJECT_ID.
    const otherStmt = await prisma.bankStatement.create({
      data: {
        bankAccountId,
        filename: `dsr-recon-test-${SUFFIX}-other.csv`,
        format: "TEST",
        rawPayload: "test fixture",
        periodStart: new Date("2026-04-01"),
        periodEnd: new Date("2026-04-30"),
        openingBalance: "0.0000",
        closingBalance: "0.0000",
        uploadedBy: OTHER_SUBJECT_ID,
        lines: {
          create: [
            { lineNo: 1, transactionDate: new Date("2026-04-05"), description: "Other test line", amount: "999.0000" },
          ],
        },
      },
      include: { lines: true },
    });
    await prisma.reconciliationMatch.create({
      data: {
        bankLineId: otherStmt.lines[0].id,
        journalLineId,
        source: MatchSource.AI,
        status: MatchStatus.APPROVED,
        approvedBy: OTHER_SUBJECT_ID,
        approvedAt: new Date(),
      },
    });

    const { reconAttribution } = await import(
      "@/lib/privacy/recon-attribution"
    );
    const testResult = await reconAttribution(prisma, TEST_SUBJECT_ID);
    const otherResult = await reconAttribution(prisma, OTHER_SUBJECT_ID);

    // TEST_SUBJECT counts unchanged from previous test.
    expect(testResult.bankStatementsUploaded).toBe(3);
    expect(testResult.reconciliationMatchesApproved).toBe(2);
    expect(testResult.aiSuggestionsAccepted).toBe(1);
    expect(testResult.aiSuggestionsRejected).toBe(1);

    // OTHER_SUBJECT sees only its own row.
    expect(otherResult.bankStatementsUploaded).toBe(1);
    expect(otherResult.reconciliationMatchesApproved).toBe(1);
    expect(otherResult.aiSuggestionsAccepted).toBe(1);
    expect(otherResult.aiSuggestionsRejected).toBe(0);
  });

  it("contract: returned object contains no contents-shaped fields", async () => {
    // Defense-in-depth: even though the type forbids it, the serialized
    // result must not accidentally include bank-line descriptions or
    // statement filenames.
    const { reconAttribution } = await import(
      "@/lib/privacy/recon-attribution"
    );
    const result = await reconAttribution(prisma, TEST_SUBJECT_ID);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("dsr-recon-test"); // no filenames
    expect(serialized).not.toContain("Test line"); // no descriptions
    expect(serialized.toLowerCase()).not.toContain("rawpayload");
  });
});
