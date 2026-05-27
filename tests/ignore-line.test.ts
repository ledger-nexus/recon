// Integration tests for the v1.0 ignore-line + bulk-suggest actions.
//
// Spins up a tiny BankStatement with three BankStatementLines, exercises
// each Server Action, and asserts the resulting DB state. Uses the shared
// ledger-core test database (DATABASE_URL).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Mock next/cache before any module that imports it loads — Server
// Actions call revalidatePath() which only works inside a Next.js
// request scope. In vitest the call throws "Invariant: static
// generation store missing." Mocking to a no-op makes the action's
// happy path return ok: true.
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

// Mock the tenant-aware session helpers. After pen-test pass 4, every
// Server Action requires a signed-in user + active tenant. In tests we
// short-circuit to the default tenant (the seed creates it).
vi.mock("@/lib/auth/session", () => ({
  requireCurrentUser: async () => ({
    id: "00000000-0000-0000-0000-000000000000",
    email: "test@example.test",
    displayName: "Test",
  }),
  requireCurrentTenant: async () => {
    const { PrismaClient } = await import("@prisma/client");
    const p = new PrismaClient();
    const t = await p.tenant.findFirstOrThrow({ where: { slug: "default" } });
    await p.$disconnect();
    return { id: t.id, slug: t.slug, name: t.name, role: "OWNER" };
  },
  NotAuthenticatedError: class NotAuthenticatedError extends Error {},
  NoTenantSelectedError: class NoTenantSelectedError extends Error {},
}));

import { PrismaClient } from "@prisma/client";
import {
  ignoreLineAction,
  unignoreLineAction,
} from "../src/app/actions/ignore-line";

const prisma = new PrismaClient();

const SUFFIX = "rec" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let statementId: string;
let bankLines: { id: string; status: string }[] = [];

beforeAll(async () => {
  // Re-use the default tenant + Northwind entity if they exist. We don't
  // create our own — too much setup for what we're testing.
  const entity = await prisma.legalEntity.findFirst({
    where: { code: "NORTHWIND" },
    select: { id: true },
  });
  if (!entity) {
    throw new Error(
      "NORTHWIND entity not found. Run `pnpm db:seed` in ledger-core first."
    );
  }

  // Resolve the cash account (1000) — bank-account FK target.
  const cashAccount = await prisma.account.findFirst({
    where: { code: "1000", OR: [{ entityId: null }, { entityId: entity.id }] },
    select: { id: true },
  });
  if (!cashAccount) {
    throw new Error("Cash account (1000) not found in chart of accounts.");
  }

  // Create a throwaway bank account for this test.
  const bankAccount = await prisma.bankAccount.create({
    data: {
      entityId: entity.id,
      accountId: cashAccount.id,
      code: `IGNORE-TEST-${SUFFIX}`,
      displayName: `Ignore-Line Test Account ${SUFFIX}`,
    },
  });

  // Create a statement with 3 lines: all UNMATCHED, summing to $0
  // (so reconciliation balances trivially with opening = closing).
  const stmt = await prisma.bankStatement.create({
    data: {
      bankAccountId: bankAccount.id,
      filename: `ignore-test-${SUFFIX}.csv`,
      format: "TEST",
      rawPayload: "test fixture",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-01-31"),
      openingBalance: "0.0000",
      closingBalance: "0.0000",
      totalLines: 3,
      pendingLines: 3,
      matchedLines: 0,
      lines: {
        create: [
          {
            lineNo: 1,
            transactionDate: new Date("2026-01-05"),
            description: "ACH credit — Acme Corp",
            amount: "1000.0000",
          },
          {
            lineNo: 2,
            transactionDate: new Date("2026-01-15"),
            description: "Wire transfer to checking — internal",
            amount: "-500.0000",
          },
          {
            lineNo: 3,
            transactionDate: new Date("2026-01-20"),
            description: "Bank fee",
            amount: "-500.0000",
          },
        ],
      },
    },
    include: { lines: true },
  });
  statementId = stmt.id;
  bankLines = stmt.lines.map((l) => ({ id: l.id, status: l.status }));
});

afterAll(async () => {
  // Cleanup: cascade should handle lines + matches via the statement FK.
  await prisma.bankStatement.deleteMany({ where: { id: statementId } });
  await prisma.bankAccount.deleteMany({
    where: { code: { startsWith: "IGNORE-TEST-" } },
  });
  await prisma.$disconnect();
});

describe("ignoreLineAction", () => {
  it("marks an UNMATCHED line as IGNORED + decrements pendingLines", async () => {
    const line = bankLines[1]; // the internal-transfer line
    const before = await prisma.bankStatement.findUniqueOrThrow({
      where: { id: statementId },
      select: { pendingLines: true },
    });

    const result = await ignoreLineAction({
      bankLineId: line.id,
      reason: "Internal transfer between own accounts",
      ignoredBy: "test-user",
    });
    expect(result.ok).toBe(true);

    const updated = await prisma.bankStatementLine.findUniqueOrThrow({
      where: { id: line.id },
      select: { status: true, ignoredAt: true, ignoredBy: true, ignoreReason: true },
    });
    expect(updated.status).toBe("IGNORED");
    expect(updated.ignoredAt).not.toBeNull();
    expect(updated.ignoredBy).toBe("test@example.test"); // stamped from authenticated user
    expect(updated.ignoreReason).toBe("Internal transfer between own accounts");

    const after = await prisma.bankStatement.findUniqueOrThrow({
      where: { id: statementId },
      select: { pendingLines: true },
    });
    expect(after.pendingLines).toBe(before.pendingLines - 1);
  });

  it("is idempotent — re-ignoring an already-IGNORED line is a no-op", async () => {
    const line = bankLines[1];
    const before = await prisma.bankStatement.findUniqueOrThrow({
      where: { id: statementId },
      select: { pendingLines: true },
    });
    const result = await ignoreLineAction({ bankLineId: line.id });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/already IGNORED/i);
    const after = await prisma.bankStatement.findUniqueOrThrow({
      where: { id: statementId },
      select: { pendingLines: true },
    });
    expect(after.pendingLines).toBe(before.pendingLines);
  });

  it("rejects ignoring a non-existent line", async () => {
    const result = await ignoreLineAction({
      bankLineId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  it("withdraws competing PROPOSED matches when ignoring", async () => {
    // Set up: take the bank-fee line, manually create a PROPOSED match
    // pointing at a real JE line (any one will do for this test).
    const line = bankLines[2];
    const someJournalLine = await prisma.journalLine.findFirst({
      select: { id: true },
    });
    if (!someJournalLine) {
      throw new Error("No journal lines in DB; seed Northwind first.");
    }
    await prisma.bankStatementLine.update({
      where: { id: line.id },
      data: { status: "PROPOSED" },
    });
    await prisma.bankStatement.update({
      where: { id: statementId },
      data: { pendingLines: { increment: 0 } }, // already counted
    });
    const match = await prisma.reconciliationMatch.create({
      data: {
        bankLineId: line.id,
        journalLineId: someJournalLine.id,
        source: "DETERMINISTIC",
        status: "PROPOSED",
      },
    });

    const result = await ignoreLineAction({ bankLineId: line.id });
    expect(result.ok).toBe(true);

    const updatedMatch = await prisma.reconciliationMatch.findUniqueOrThrow({
      where: { id: match.id },
      select: { status: true },
    });
    expect(updatedMatch.status).toBe("WITHDRAWN");
  });
});

describe("unignoreLineAction", () => {
  it("restores an IGNORED line to UNMATCHED + increments pendingLines", async () => {
    const line = bankLines[1]; // Same internal-transfer line from above.
    const before = await prisma.bankStatement.findUniqueOrThrow({
      where: { id: statementId },
      select: { pendingLines: true },
    });
    const result = await unignoreLineAction(line.id);
    expect(result.ok).toBe(true);

    const updated = await prisma.bankStatementLine.findUniqueOrThrow({
      where: { id: line.id },
      select: { status: true, ignoredAt: true, ignoredBy: true },
    });
    expect(updated.status).toBe("UNMATCHED");
    // Audit columns deliberately preserved — auditors see the full history.
    expect(updated.ignoredAt).not.toBeNull();
    expect(updated.ignoredBy).toBe("test@example.test"); // stamped from authenticated user

    const after = await prisma.bankStatement.findUniqueOrThrow({
      where: { id: statementId },
      select: { pendingLines: true },
    });
    expect(after.pendingLines).toBe(before.pendingLines + 1);
  });

  it("rejects un-ignoring a non-IGNORED line", async () => {
    const line = bankLines[0]; // Still UNMATCHED.
    const result = await unignoreLineAction(line.id);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not IGNORED/i);
  });
});
