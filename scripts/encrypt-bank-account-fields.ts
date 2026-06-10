// One-shot migration: encrypt the existing `bank_account.displayName`,
// `bank_account.bankName`, and `bank_account.accountNumberLast4` columns
// in place. Idempotent — skips per-field if the column already looks
// encrypted.
//
// Confidentiality TSC. Run AFTER:
//   1. FIELD_ENCRYPTION_KEY is set in the target environment
//   2. The extension is deployed with these three columns in
//      ENCRYPTED_COLUMNS
//
// Usage:
//   FIELD_ENCRYPTION_KEY=$(grep FIELD_ .env.local | cut -d= -f2) \
//     npx tsx scripts/encrypt-bank-account-fields.ts
//
// BankAccount row counts are small (one per bank account per customer);
// no pagination needed but we keep defensive shape for consistency.
// Each field independently gated by looksEncrypted so the script is
// resumable after a crash mid-row.

import { PrismaClient } from "@prisma/client";
import {
  encryptField,
  looksEncrypted,
} from "../src/lib/soc2/field-encryption";

const COLUMNS = ["displayName", "bankName", "accountNumberLast4"] as const;
type EncryptableField = (typeof COLUMNS)[number];

async function main(): Promise<void> {
  // Raw client — bypass the extension so we write ciphertext directly.
  const prisma = new PrismaClient();
  console.log("[migrate] starting backfill of confidential columns");

  const rows = await prisma.bankAccount.findMany({
    select: {
      id: true,
      displayName: true,
      bankName: true,
      accountNumberLast4: true,
    },
    orderBy: { id: "asc" },
  });

  let total = 0;
  const stats: Record<EncryptableField, { encrypted: number; skippedAlready: number; skippedEmpty: number }> = {
    displayName: { encrypted: 0, skippedAlready: 0, skippedEmpty: 0 },
    bankName: { encrypted: 0, skippedAlready: 0, skippedEmpty: 0 },
    accountNumberLast4: { encrypted: 0, skippedAlready: 0, skippedEmpty: 0 },
  };

  for (const row of rows) {
    total++;
    const updates: Partial<Record<EncryptableField, string>> = {};
    const guards: Partial<Record<EncryptableField, string>> = {};
    for (const col of COLUMNS) {
      const current = row[col];
      if (!current) {
        stats[col].skippedEmpty++;
        continue;
      }
      if (looksEncrypted(current)) {
        stats[col].skippedAlready++;
        continue;
      }
      const ct = encryptField(current);
      if (!ct) {
        stats[col].skippedEmpty++;
        continue;
      }
      updates[col] = ct;
      guards[col] = current; // race-safe selector
      stats[col].encrypted++;
    }
    if (Object.keys(updates).length === 0) continue;
    await prisma.bankAccount.updateMany({
      where: { id: row.id, ...guards },
      data: updates,
    });
  }

  console.log(`[migrate] complete. total_rows=${total}`);
  for (const col of COLUMNS) {
    const s = stats[col];
    console.log(
      `[migrate]   ${col}: encrypted=${s.encrypted} skipped_already=${s.skippedAlready} skipped_empty=${s.skippedEmpty}`
    );
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
