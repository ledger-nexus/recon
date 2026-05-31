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
  // Party rows from the Party READ test — match by the per-run suffix
  // baked into the code, so we never clobber other tests' fixtures.
  await rawPrisma.party.deleteMany({
    where: { code: { contains: SUFFIX } },
  });
  // Per-test BankAccount rows from the BankAccount encryption tests
  // (code shape: ENC-BA-{SUFFIX}-{perTestHex}).
  await rawPrisma.bankAccount.deleteMany({
    where: { code: { contains: `ENC-BA-${SUFFIX}` } },
  });
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

// ─────────────────────────────────────────────────────────────────────────────
// Party.displayName — READ side. Recon does NOT own Party (ledger-core
// writes it). The extension's job on this end is purely to decrypt
// what ledger-core encrypted. The matching pipeline at
// `src/lib/matching/candidates.ts` line 103 includes `party.displayName`
// in the candidate payload; if the extension wasn't wired here, the
// UI would surface ciphertext.
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: Party READ side (Confidentiality TSC)", () => {
  let partyId: string;
  let partyCode: string;
  const plaintextDisplayName = `Customer Acme Corp ${SUFFIX}`;

  // Production reality: recon NEVER writes Party (only ledger-core
  // does — Party doesn't even expose `tenantId` in recon's Prisma
  // schema mirror, intentionally). We simulate the "ledger-core
  // already encrypted this row and persisted it" state by inserting
  // raw ciphertext via SQL with the tenantId column populated, then
  // verify recon's extended client decrypts it on read.
  beforeEach(async () => {
    // Per-test unique code so two `it(...)` blocks don't collide on
    // the (entityId, code) unique index.
    partyCode = `ENC-RECON-PARTY-${SUFFIX}-${randomBytes(2).toString("hex")}`;
    const entity = await rawPrisma.legalEntity.findFirst({
      where: { code: "NORTHWIND" },
      select: { id: true, tenantId: true },
    });
    if (!entity) throw new Error("NORTHWIND entity missing");
    const { encryptField } = await import("@/lib/soc2/field-encryption");
    const ct = encryptField(plaintextDisplayName);
    if (!ct) throw new Error("encryptField returned null");
    // Raw SQL insert because recon's Party schema mirror omits
    // tenantId (recon never writes Party in production — this gap
    // is intentional / consistent with the no-write contract).
    const rows = await rawPrisma.$queryRaw<{ id: string }[]>`
      INSERT INTO party (id, "tenantId", "entityId", code, "displayName", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${entity.tenantId}::uuid, ${entity.id}::uuid, ${partyCode}, ${ct}, NOW(), NOW())
      RETURNING id::text
    `;
    partyId = rows[0].id;
  });

  it("on-disk Party.displayName is encrypted (raw prisma probe)", async () => {
    const raw = await rawPrisma.party.findUnique({
      where: { id: partyId },
      select: { displayName: true, code: true },
    });
    expect(raw?.displayName).not.toBe(plaintextDisplayName);
    expect(looksEncrypted(raw?.displayName)).toBe(true);
    // `code` stays plaintext — it's the searchable lookup key.
    expect(raw?.code).toBe(partyCode);
  });

  it("recon's matching candidates path sees plaintext displayName", async () => {
    const { prisma } = await import("@/lib/db");
    // Mirror the exact shape candidates.ts uses:
    //   include: { party: { select: { displayName: true } } }
    const party = await prisma.party.findUnique({
      where: { id: partyId },
      select: { displayName: true, code: true },
    });
    expect(party?.displayName).toBe(plaintextDisplayName);
    expect(party?.code).toBe(partyCode);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BankAccount — recon-owned. The trio of displayName + bankName +
// accountNumberLast4 is the "financial profile of this account" surface.
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: BankAccount (Confidentiality TSC)", () => {
  let testBankAccountId: string;
  let testCode: string;
  const plaintextDisplayName = `Chase Operating — Acme ${SUFFIX}`;
  const plaintextBankName = `JPMorgan Chase ${SUFFIX}`;
  const plaintextLast4 = "9876";

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    const entity = await rawPrisma.legalEntity.findFirst({
      where: { code: "NORTHWIND" },
      select: { id: true },
    });
    if (!entity) throw new Error("NORTHWIND entity missing");
    const cashAccount = await rawPrisma.account.findFirst({
      where: { code: "1000", OR: [{ entityId: null }, { entityId: entity.id }] },
      select: { id: true },
    });
    if (!cashAccount) throw new Error("Cash account 1000 missing");
    // Per-test unique code so the @unique index doesn't collide
    // between `it(...)` blocks.
    testCode = `ENC-BA-${SUFFIX}-${randomBytes(2).toString("hex")}`;
    // Write via the EXTENDED client so the extension encrypts on
    // the way in.
    const created = await prisma.bankAccount.create({
      data: {
        entityId: entity.id,
        accountId: cashAccount.id,
        code: testCode,
        displayName: plaintextDisplayName,
        bankName: plaintextBankName,
        accountNumberLast4: plaintextLast4,
      },
    });
    testBankAccountId = created.id;
  });

  it("on-disk displayName, bankName, accountNumberLast4 are ciphertext", async () => {
    const raw = await rawPrisma.bankAccount.findUnique({
      where: { id: testBankAccountId },
      select: {
        displayName: true,
        bankName: true,
        accountNumberLast4: true,
        code: true,
      },
    });
    expect(raw?.displayName).not.toBe(plaintextDisplayName);
    expect(looksEncrypted(raw?.displayName)).toBe(true);
    expect(raw?.bankName).not.toBe(plaintextBankName);
    expect(looksEncrypted(raw?.bankName)).toBe(true);
    expect(raw?.accountNumberLast4).not.toBe(plaintextLast4);
    expect(looksEncrypted(raw?.accountNumberLast4)).toBe(true);
    // code stays plaintext (lookup key)
    expect(raw?.code).toBe(testCode);
  });

  it("app surface auto-decrypts all three columns on read", async () => {
    const { prisma } = await import("@/lib/db");
    const acct = await prisma.bankAccount.findUnique({
      where: { id: testBankAccountId },
      select: {
        displayName: true,
        bankName: true,
        accountNumberLast4: true,
        code: true,
      },
    });
    expect(acct?.displayName).toBe(plaintextDisplayName);
    expect(acct?.bankName).toBe(plaintextBankName);
    expect(acct?.accountNumberLast4).toBe(plaintextLast4);
    expect(acct?.code).toBe(testCode);
  });
});
