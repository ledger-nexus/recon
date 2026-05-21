// Recon seed. Idempotent. Assumes the Northwind ledger-core seed has
// already been run against the same database, so the LegalEntity
// "NORTHWIND" and the Account "1000 Cash — Operating" exist.
//
// Sets up:
//   - One BankAccount linked to Northwind / account 1000
//   - One sample BankStatement parsed from prisma/fixtures/acme-bank-march-2026.csv

import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBankCsv } from "../src/lib/csv/parser";

const prisma = new PrismaClient();

async function main() {
  console.log("Recon seed — wiring sample BankAccount + BankStatement...");

  const entity = await prisma.legalEntity.findUnique({
    where: { code: "NORTHWIND" },
    select: { id: true },
  });
  if (!entity) {
    console.error(
      "NORTHWIND entity not found. Run ledger-core's seed first against the same DATABASE_URL."
    );
    process.exit(1);
  }

  const cashAccount = await prisma.account.findFirst({
    where: {
      OR: [{ entityId: null }, { entityId: entity.id }],
      code: "1000",
      isBank: true,
    },
    select: { id: true },
  });
  if (!cashAccount) {
    console.error("Cash account 1000 (isBank=true) not found in the shared chart.");
    process.exit(1);
  }

  const bankAccount = await prisma.bankAccount.upsert({
    where: { code: "CHASE-OPERATING" },
    create: {
      entityId: entity.id,
      accountId: cashAccount.id,
      code: "CHASE-OPERATING",
      displayName: "Chase Operating",
      bankName: "JP Morgan Chase",
      accountNumberLast4: "4291",
      currencyId: "USD",
    },
    update: {},
  });
  console.log(`  ✓ BankAccount ${bankAccount.code}`);

  // Parse + persist the sample statement (idempotent on filename + bankAccount).
  const fixturePath = join(__dirname, "fixtures", "acme-bank-march-2026.csv");
  const csv = readFileSync(fixturePath, "utf-8");
  const parsed = parseBankCsv(csv);

  const existing = await prisma.bankStatement.findFirst({
    where: { bankAccountId: bankAccount.id, filename: "acme-bank-march-2026.csv" },
    select: { id: true },
  });
  if (existing) {
    console.log(`  ✓ Statement already loaded (${existing.id.slice(0, 8)}). Skipping.`);
  } else {
    const stmt = await prisma.bankStatement.create({
      data: {
        bankAccountId: bankAccount.id,
        filename: "acme-bank-march-2026.csv",
        format: "GENERIC_CSV",
        rawPayload: csv,
        periodStart: parsed.meta.periodStart,
        periodEnd: parsed.meta.periodEnd,
        openingBalance: parsed.meta.openingBalance.toFixed(4),
        closingBalance: parsed.meta.closingBalance.toFixed(4),
        totalLines: parsed.lines.length,
        matchedLines: 0,
        pendingLines: parsed.lines.length,
        lines: {
          create: parsed.lines.map((l) => ({
            lineNo: l.lineNo,
            transactionDate: l.transactionDate,
            description: l.description,
            amount: l.amount.toFixed(4),
            runningBalance: l.runningBalance ? l.runningBalance.toFixed(4) : null,
          })),
        },
      },
      select: { id: true },
    });
    console.log(`  ✓ Statement loaded (${stmt.id.slice(0, 8)}) with ${parsed.lines.length} lines`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
