// One-shot migration: encrypt the existing `ai_suggestion.candidatesJson`
// Json column in place. Idempotent — skips rows where the column
// already looks encrypted.
//
// Confidentiality TSC. Run AFTER:
//   1. FIELD_ENCRYPTION_KEY is set in the target environment
//   2. The extension is deployed with AiSuggestion.candidatesJson
//      (type "json") in ENCRYPTED_COLUMNS
//
// Usage:
//   FIELD_ENCRYPTION_KEY=$(grep FIELD_ .env.local | cut -d= -f2) \
//     npx tsx scripts/encrypt-ai-suggestion-candidates.ts
//
// Paginated by id ASC. candidatesJson is typically small (3-10 KB —
// a handful of candidates with short rationales) so the batch is
// generous.

import { PrismaClient } from "@prisma/client";
import {
  encryptField,
  looksEncrypted,
} from "../src/lib/soc2/field-encryption";

const BATCH_SIZE = 200;

async function main(): Promise<void> {
  // Raw client — bypass the extension so we write ciphertext directly
  // (and read the verbatim on-disk JsonValue, not the auto-decrypted
  // shape).
  const prisma = new PrismaClient();
  console.log("[migrate] starting backfill of confidential column");

  let total = 0;
  let encrypted = 0;
  let skippedAlready = 0;
  let skippedEmpty = 0;
  let lastId: string | undefined;

  while (true) {
    const rows = await prisma.aiSuggestion.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
      select: { id: true, candidatesJson: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      lastId = row.id;
      const cj = row.candidatesJson;
      if (cj === null || cj === undefined) {
        skippedEmpty++;
        continue;
      }
      if (typeof cj === "string" && looksEncrypted(cj)) {
        skippedAlready++;
        continue;
      }
      const ct = encryptField(JSON.stringify(cj));
      if (!ct) {
        skippedEmpty++;
        continue;
      }
      await prisma.aiSuggestion.updateMany({
        where: { id: row.id },
        data: { candidatesJson: ct },
      });
      encrypted++;
    }
    if (total % 1000 === 0) {
      console.log(
        `[migrate] scanned ${total} rows; ${encrypted} encrypted, ${skippedAlready} already done, ${skippedEmpty} empty`
      );
    }
  }

  console.log(
    `[migrate] complete. total=${total} encrypted=${encrypted} skipped_already=${skippedAlready} skipped_empty=${skippedEmpty}`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
