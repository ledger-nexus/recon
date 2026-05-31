// One-shot migration: encrypt `bank_statement.filename` and
// `bank_statement.rawPayload` in place. Idempotent — skips per-field
// if the column already looks encrypted.
//
// Confidentiality TSC. Run AFTER:
//   1. FIELD_ENCRYPTION_KEY is set in the target environment
//   2. The extension is deployed with BankStatement.filename and
//      BankStatement.rawPayload in ENCRYPTED_COLUMNS
//
// Usage:
//   FIELD_ENCRYPTION_KEY=$(grep FIELD_ .env.local | cut -d= -f2) \
//     npx tsx scripts/encrypt-bank-statement-fields.ts
//
// Paginated by id ASC. rawPayload can be large (tens of KB per row),
// so the batch is conservative.

import { PrismaClient } from "@prisma/client";
import {
  encryptField,
  looksEncrypted,
} from "../src/lib/soc2/field-encryption";

const BATCH_SIZE = 50;
const COLUMNS = ["filename", "rawPayload"] as const;
type EncryptableField = (typeof COLUMNS)[number];

async function main(): Promise<void> {
  // Raw client — bypass the extension so we write ciphertext directly.
  const prisma = new PrismaClient();
  console.log("[migrate] starting backfill of confidential columns");

  const stats: Record<EncryptableField, { encrypted: number; skippedAlready: number; skippedEmpty: number }> = {
    filename: { encrypted: 0, skippedAlready: 0, skippedEmpty: 0 },
    rawPayload: { encrypted: 0, skippedAlready: 0, skippedEmpty: 0 },
  };

  let total = 0;
  let lastId: string | undefined;

  while (true) {
    const rows = await prisma.bankStatement.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
      select: { id: true, filename: true, rawPayload: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      lastId = row.id;
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
      await prisma.bankStatement.updateMany({
        where: { id: row.id, ...guards },
        data: updates,
      });
    }
    if (total % 200 === 0) {
      console.log(
        `[migrate] scanned ${total} rows; filename.encrypted=${stats.filename.encrypted} rawPayload.encrypted=${stats.rawPayload.encrypted}`
      );
    }
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
