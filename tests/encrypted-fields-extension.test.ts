// Real-DB roundtrip test for the recon encrypted-fields extension.
// Confidentiality TSC.
//
// Writes a BankStatementLine via the extended client, reads it back
// through the raw PrismaClient to confirm the on-disk `description`
// is ciphertext, and via the extended client to confirm the app
// surface sees plaintext.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { looksEncrypted } from "@/lib/soc2/field-encryption";

const rawPrisma = new PrismaClient();
const SUFFIX = randomBytes(4).toString("hex");

let bankAccountId: string;

beforeAll(async () => {
  // Use a known test key. Real production sets via Vercel env.
  process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const { _setKeyForTesting } = await import("@/lib/soc2/field-encryption");
  _setKeyForTesting(null);

  // The default-tenant Northwind seed creates the chart of accounts +
  // entity we need. Bail with a clear error if the seed hasn't run.
  const entity = await rawPrisma.legalEntity.findFirst({
    where: { code: "NORTHWIND" },
    select: { id: true },
  });
  if (!entity) {
    throw new Error(
      "NORTHWIND entity not found. Run pnpm db:seed in ledger-core first."
    );
  }
  const cashAccount = await rawPrisma.account.findFirst({
    where: { code: "1000", OR: [{ entityId: null }, { entityId: entity.id }] },
    select: { id: true },
  });
  if (!cashAccount) {
    throw new Error("Cash account (1000) not found.");
  }
  const bankAccount = await rawPrisma.bankAccount.create({
    data: {
      entityId: entity.id,
      accountId: cashAccount.id,
      code: `ENC-TEST-${SUFFIX}`,
      displayName: `Encryption Test Account ${SUFFIX}`,
    },
  });
  bankAccountId = bankAccount.id;
});

afterAll(async () => {
  // Targeted cleanup of test rows only.
  await rawPrisma.bankStatementLine.deleteMany({
    where: { statement: { bankAccountId } },
  });
  await rawPrisma.bankStatement.deleteMany({
    where: { bankAccountId },
  });
  await rawPrisma.bankAccount.deleteMany({ where: { id: bankAccountId } });
  await rawPrisma.$disconnect();
});

describe("encrypted-fields extension: BankStatementLine (Confidentiality TSC)", () => {
  let lineId: string;
  const plaintextDescription = `ACH credit — Acme Corp invoice ${SUFFIX}`;

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    // Create a statement with one line via the extended client. The
    // line's `description` should be encrypted on disk; everything
    // else stays plaintext (querying by amount + transactionDate has
    // to work).
    const statement = await prisma.bankStatement.create({
      data: {
        bankAccountId,
        filename: `enc-test-${SUFFIX}.csv`,
        format: "TEST",
        rawPayload: "test fixture",
        periodStart: new Date("2026-01-01"),
        periodEnd: new Date("2026-01-31"),
        openingBalance: "0.0000",
        closingBalance: "1000.0000",
        totalLines: 1,
        pendingLines: 1,
        matchedLines: 0,
        lines: {
          create: [
            {
              lineNo: 1,
              transactionDate: new Date("2026-01-15"),
              description: plaintextDescription,
              amount: "1000.0000",
            },
          ],
        },
      },
      include: { lines: true },
    });
    lineId = statement.lines[0].id;
  });

  it("on-disk description is encrypted (raw prisma probe)", async () => {
    const raw = await rawPrisma.bankStatementLine.findUnique({
      where: { id: lineId },
      select: { description: true, amount: true, transactionDate: true },
    });
    expect(raw?.description).not.toBe(plaintextDescription);
    expect(looksEncrypted(raw?.description)).toBe(true);
    // Amount + transactionDate are NOT in the registry — they must
    // stay queryable. Verify they're still plaintext-shaped.
    expect(raw?.amount.toString()).toBe("1000");
    expect(raw?.transactionDate).toBeInstanceOf(Date);
  });

  it("app surface sees plaintext on description", async () => {
    const { prisma } = await import("@/lib/db");
    const line = await prisma.bankStatementLine.findUnique({
      where: { id: lineId },
      select: { description: true, amount: true },
    });
    expect(line?.description).toBe(plaintextDescription);
    expect(line?.amount.toString()).toBe("1000");
  });

  it("findMany over BankStatementLine decrypts each row", async () => {
    const { prisma } = await import("@/lib/db");
    const lines = await prisma.bankStatementLine.findMany({
      where: { statement: { bankAccountId } },
      select: { description: true },
    });
    for (const l of lines) {
      expect(l.description).toBe(plaintextDescription);
    }
  });
});
