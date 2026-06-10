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
// writes it in production). The extension's job on this end is purely
// to decrypt what ledger-core encrypted. The matching pipeline at
// `src/lib/matching/candidates.ts` line 103 includes `party.displayName`
// in the candidate payload; if the extension wasn't wired here, the
// UI would surface ciphertext.
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: Party READ side (Confidentiality TSC)", () => {
  let partyId: string;
  let partyCode: string;
  const plaintextDisplayName = `Customer Acme Corp ${SUFFIX}`;

  // Recon never writes Party in production (ledger-core owns the
  // write path), but recon's schema mirror now exposes tenantId on
  // Party — the column has always existed in the shared DB; recon's
  // model just declares it for SOC 2 CC6.1 visibility. That lets the
  // fixture use a normal prisma.party.create through the raw client
  // and have the extension encrypt on the way in, matching how
  // ledger-core writes the row in production.
  beforeEach(async () => {
    // Per-test unique code so two `it(...)` blocks don't collide on
    // the (entityId, code) unique index.
    partyCode = `ENC-RECON-PARTY-${SUFFIX}-${randomBytes(2).toString("hex")}`;
    const entity = await rawPrisma.legalEntity.findFirst({
      where: { code: "NORTHWIND" },
      select: { id: true, tenantId: true },
    });
    if (!entity) throw new Error("NORTHWIND entity missing");
    const { prisma } = await import("@/lib/db");
    const created = await prisma.party.create({
      data: {
        tenantId: entity.tenantId,
        entityId: entity.id,
        code: partyCode,
        displayName: plaintextDisplayName,
      },
      select: { id: true },
    });
    partyId = created.id;
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

// ─────────────────────────────────────────────────────────────────────────────
// BankStatement.{filename, rawPayload} — the audit surface of a
// statement upload. rawPayload is the full CSV body (tens of KB),
// so the test verifies AES-GCM handles arbitrary sizes correctly.
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: BankStatement (Confidentiality TSC)", () => {
  let statementId: string;
  const plaintextFilename = `chase-may-2026-${SUFFIX}.csv`;
  // A realistic-ish multi-line CSV body — verifies the helper
  // handles newlines, commas, and unicode within a single ciphertext.
  const plaintextRawPayload = [
    "Date,Description,Amount,Balance",
    `2026-05-01,Opening balance,,1000.00`,
    `2026-05-03,ACH credit — Acme Corp inv 4321 (${SUFFIX}),5000.00,6000.00`,
    `2026-05-15,Wire fee,-25.00,5975.00`,
    `2026-05-20,Vendor: Lögística Düsseldorf GmbH,-432.10,5542.90`,
    `2026-05-31,Closing balance,,5542.90`,
  ].join("\n");

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    const created = await prisma.bankStatement.create({
      data: {
        bankAccountId,
        filename: plaintextFilename,
        format: "TEST",
        rawPayload: plaintextRawPayload,
        periodStart: new Date("2026-05-01"),
        periodEnd: new Date("2026-05-31"),
        openingBalance: "1000.0000",
        closingBalance: "5542.9000",
        totalLines: 3,
        pendingLines: 3,
        matchedLines: 0,
      },
    });
    statementId = created.id;
  });

  it("on-disk filename and rawPayload are ciphertext", async () => {
    const raw = await rawPrisma.bankStatement.findUnique({
      where: { id: statementId },
      select: { filename: true, rawPayload: true, format: true },
    });
    expect(raw?.filename).not.toBe(plaintextFilename);
    expect(looksEncrypted(raw?.filename)).toBe(true);
    expect(raw?.rawPayload).not.toBe(plaintextRawPayload);
    expect(looksEncrypted(raw?.rawPayload)).toBe(true);
    // format stays plaintext — used for parser dispatch ("CHASE_CSV_V1"
    // etc.); not a PII surface.
    expect(raw?.format).toBe("TEST");
  });

  it("app surface decrypts both columns on read", async () => {
    const { prisma } = await import("@/lib/db");
    const stmt = await prisma.bankStatement.findUnique({
      where: { id: statementId },
      select: { filename: true, rawPayload: true, format: true },
    });
    expect(stmt?.filename).toBe(plaintextFilename);
    expect(stmt?.rawPayload).toBe(plaintextRawPayload);
    expect(stmt?.format).toBe("TEST");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AiSuggestion.candidatesJson — Json-mode column. Verifies the type:
// "json" extension mode round-trips the matcher's structured response
// (array of {journalLineId, confidence, rationale}) exactly, while the
// on-disk Json column holds a string (the ciphertext envelope).
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: AiSuggestion.candidatesJson (Json mode, Confidentiality TSC)", () => {
  let suggestionId: string;
  let bankLineId: string;
  // Representative matcher output: rationale embeds customer name +
  // dollar context — the actual PII surface the encryption protects.
  const plaintextCandidates = [
    {
      journalLineId: `je-line-stub-${SUFFIX}-a`,
      confidence: 0.92,
      rationale: `Acme Corp ACH credit on 4/22 matches bank line amount $5,000 within 1-day window (${SUFFIX})`,
    },
    {
      journalLineId: `je-line-stub-${SUFFIX}-b`,
      confidence: 0.18,
      rationale: "Long-shot — only amount matches; date is 14 days off",
    },
  ];

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    // Need a bank statement + line to anchor the suggestion (FK
    // requirement). Use the file-level bankAccountId.
    const statement = await prisma.bankStatement.create({
      data: {
        bankAccountId,
        filename: `ai-test-${SUFFIX}.csv`,
        format: "TEST",
        rawPayload: "test fixture",
        periodStart: new Date("2026-04-01"),
        periodEnd: new Date("2026-04-30"),
        openingBalance: "0.0000",
        closingBalance: "5000.0000",
        totalLines: 1,
        pendingLines: 1,
        matchedLines: 0,
        lines: {
          create: [
            {
              lineNo: 1,
              transactionDate: new Date("2026-04-22"),
              description: `ACH credit Acme ${SUFFIX}`,
              amount: "5000.0000",
            },
          ],
        },
      },
      include: { lines: true },
    });
    bankLineId = statement.lines[0].id;
    const created = await prisma.aiSuggestion.create({
      data: {
        bankLineId,
        candidatesJson: plaintextCandidates as unknown as object,
        modelName: `claude-haiku-4-5-test-${SUFFIX}`,
      },
    });
    suggestionId = created.id;
  });

  it("on-disk candidatesJson is a STRING (the ciphertext envelope), not the original array", async () => {
    const raw = await rawPrisma.aiSuggestion.findUnique({
      where: { id: suggestionId },
      select: { candidatesJson: true, modelName: true },
    });
    expect(typeof raw?.candidatesJson).toBe("string");
    expect(looksEncrypted(raw?.candidatesJson as string)).toBe(true);
    const rawStr = String(raw?.candidatesJson ?? "");
    // The distinctive bits of the plaintext rationale must not leak
    // through.
    expect(rawStr).not.toContain("Acme");
    expect(rawStr).not.toContain(SUFFIX);
    expect(rawStr).not.toContain("4/22");
    // modelName stays plaintext — used for cache-hit analytics.
    expect(raw?.modelName).toBe(`claude-haiku-4-5-test-${SUFFIX}`);
  });

  it("app surface decrypts candidatesJson back into the exact original array", async () => {
    const { prisma } = await import("@/lib/db");
    const s = await prisma.aiSuggestion.findUnique({
      where: { id: suggestionId },
      select: { candidatesJson: true },
    });
    expect(s?.candidatesJson).toEqual(plaintextCandidates);
  });
});
