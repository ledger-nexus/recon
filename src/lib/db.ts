// Singleton PrismaClient with the SOC 2 encrypted-fields extension.
//
// Next.js hot-reloads modules in dev, which creates new PrismaClient
// instances and exhausts the Postgres connection pool. The standard
// workaround is to attach the client to a global so HMR reuses it.
//
// Encrypted-fields extension (Confidentiality TSC): transparently
// AES-256-GCM-encrypts on write + decrypts on read for the columns
// listed in `src/lib/db/encrypted-fields-extension.ts`. In recon
// that's `BankStatementLine.description` — the bank's free-text
// vendor/payment identifier, which is high-correlation customer
// data. Mirror of the same pattern in ledger-core.

import { PrismaClient } from "@prisma/client";
import { encryptedFieldsExtension } from "@/lib/db/encrypted-fields-extension";

function buildPrisma(): PrismaClient {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
  // Type cast after $extends — see ledger-core/src/lib/db.ts for the
  // full rationale. The extension's runtime hooks still fire; only
  // the static type is downcast so existing PrismaClient consumers
  // typecheck.
  return base.$extends(encryptedFieldsExtension) as unknown as PrismaClient;
}

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient = global.prisma ?? buildPrisma();

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}
