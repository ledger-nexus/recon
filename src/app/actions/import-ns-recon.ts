"use server";

// Server Action: import a NetSuite bank-reconciliation bundle.
//
// Final orchestration layer of the recon NetSuite sprint (PRs #17-#19
// + this). Wraps `importFromNsRecon` with:
//
//   - Session-bound `tenantId` resolution via `requireCurrentTenant()`.
//     CC6.1 — explicit input means cross-tenant misuse shows up at
//     this call site, not buried inside the orchestrator.
//
//   - Entity resolver via `NSSUB-{internalid}` code convention
//     (matches ledger-core's NS bootstrap mapper). Tenant-scoped.
//
//   - Bank GL account resolver via the LINEAGE TRIPLE
//     `(sourceSystem='netsuite', sourceRecordType='Account',
//     sourceRecordId=<internalid>)` against ledger-core's Account
//     table (mirrored read-only in recon).
//
//   - JournalLine resolver via the LINEAGE TRIPLE on JournalEntry.
//     Picks the journal line that hits the BANK GL account — that's
//     the line a `ReconciliationMatch` should reference (matching the
//     bank movement to the GL movement). If multiple lines hit the
//     bank account (rare — split deposits), picks the first by
//     lineNo.
//
//   - JSON parse + minimal shape validation.
//
//   - Result envelope the UI can render: totals + per-statement
//     details + per-statement errors.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";
import {
  importFromNsRecon,
  type ImportFromNsReconResult,
  type NsReconExport,
} from "@/lib/mappers/netsuite";

export interface ImportNsReconInput {
  /** JSON-encoded NS bank-reconciliation export bundle. */
  bundleJson: string;
  /**
   * Optional override: NS subsidiary internal id → recon LegalEntity
   * code mapping. Defaults to `NSSUB-{internalid}` convention.
   */
  subsidiaryEntityCodeMap?: Record<string, string>;
}

export interface ImportNsReconState {
  ok: boolean;
  message: string;
  result?: ImportFromNsReconResult;
}

export async function importNsReconAction(
  input: ImportNsReconInput
): Promise<ImportNsReconState> {
  try {
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    // 1. Parse + minimally validate the bundle.
    let bundle: NsReconExport;
    try {
      bundle = JSON.parse(input.bundleJson) as NsReconExport;
    } catch (e) {
      return {
        ok: false,
        message: `Could not parse bundleJson as JSON: ${e instanceof Error ? e.message : "unknown"}`,
      };
    }
    if (
      !bundle ||
      typeof bundle !== "object" ||
      !Array.isArray(bundle.bank_accounts) ||
      !Array.isArray(bundle.statements)
    ) {
      return {
        ok: false,
        message:
          "bundleJson is missing required top-level fields. Expected: { exported_at, account_id, bank_accounts: [...], statements: [...] }",
      };
    }

    const subsidiaryEntityCodeMap = input.subsidiaryEntityCodeMap ?? {};

    // 2. Build the closure over the current tenant id so resolvers
    // capture it. CC6.1: tenant scope is enforced inside each resolver.
    const result = await importFromNsRecon(prisma, {
      export: bundle,

      // Entity resolver: tenant-scoped LegalEntity lookup by code.
      resolveEntityId: async ({ nsSubsidiaryInternalId }) => {
        const code =
          subsidiaryEntityCodeMap[nsSubsidiaryInternalId] ??
          `NSSUB-${nsSubsidiaryInternalId}`;
        const entity = await prisma.legalEntity.findFirst({
          where: { code, tenantId: tenant.id },
          select: { id: true },
        });
        return entity?.id ?? "";
      },

      // Bank GL account resolver: lineage triple on ledger-core's
      // Account table. We require the NS Account to have been
      // bootstrapped via ledger-core's universal NS mapper (sets
      // sourceSystem='netsuite', sourceRecordType='Account',
      // sourceRecordId=<NS internalid>).
      resolveBankGlAccountId: async ({ nsGlAccountInternalId }) => {
        const account = await prisma.account.findFirst({
          where: {
            sourceSystem: "netsuite",
            sourceRecordType: "Account",
            sourceRecordId: nsGlAccountInternalId,
          },
          select: { id: true },
        });
        return account?.id ?? "";
      },

      // Journal line resolver: walk the lineage triple to find the
      // JournalEntry, then pick the line that hits the bank GL account.
      //
      // Why "pick the bank-side line": ReconciliationMatch.journalLineId
      // should reference the line of the JE that clears the bank
      // account (the Cr Cash on a payment OUT, the Dr Cash on a
      // deposit IN). Other lines on the same JE are accounts payable /
      // receivable / etc. — not what the bank statement is reconciling
      // against.
      //
      // For the resolution to work cleanly:
      //   - The matched_transaction_type maps to the JE's
      //     sourceRecordType — passed verbatim.
      //   - The matched_transaction_id maps to sourceRecordId.
      //   - Among the JE's lines, prefer the one whose Account has
      //     subtype = BANK (the bank GL account). Falls back to the
      //     first line by lineNo if no bank line found (defensive).
      resolveJournalLineId: async ({
        matchedTransactionType,
        matchedTransactionInternalId,
      }) => {
        const je = await prisma.journalEntry.findFirst({
          where: {
            sourceSystem: "netsuite",
            sourceRecordType: matchedTransactionType,
            sourceRecordId: matchedTransactionInternalId,
          },
          select: {
            lines: {
              select: {
                id: true,
                lineNo: true,
                account: { select: { subtype: true } },
              },
              orderBy: { lineNo: "asc" },
            },
          },
        });
        if (!je || je.lines.length === 0) return null;

        // Prefer the line whose Account.subtype indicates it's a bank
        // line. (Accounts of subtype = "BANK" are the cash GL accounts
        // recon reconciles against.)
        const bankLine = je.lines.find((l) => l.account.subtype === "BANK");
        if (bankLine) return bankLine.id;

        // Defensive fallback: first line by lineNo. Logged as a soft
        // signal that the resolver took the fallback path.
        return je.lines[0].id;
      },
    });

    // 3. Revalidate the statements + dashboard UI so the import
    // surfaces immediately.
    revalidatePath("/statements");
    revalidatePath("/");

    const { totals } = result;
    const summary =
      `Processed ${totals.statementsProcessed} statement(s): ` +
      `${totals.statementsCreated} created, ` +
      `${totals.statementsSkipped} skipped (duplicate), ` +
      `${totals.statementsErrored} errored. ` +
      `${totals.linesCreated} bank line(s); ` +
      `${totals.matchesCreated} pre-existing match(es) imported, ` +
      `${totals.matchesSkipped} skipped (GL not yet imported). ` +
      `${totals.warningCount} warning(s).`;

    return { ok: true, message: summary, result };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, message: "Not authenticated." };
    }
    if (e instanceof NoTenantSelectedError) {
      return { ok: false, message: "No tenant selected." };
    }
    return {
      ok: false,
      message: `Unexpected error: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
}
