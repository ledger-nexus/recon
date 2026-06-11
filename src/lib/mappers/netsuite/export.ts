// NetSuite bank-reconciliation reverse exporter.
//
// The roundtrip-proof companion to importFromNsRecon. Mirrors the
// just-shipped revenue-rec NS reverse exporter pattern + ledger-core's
// QBO/NS export.ts pattern. Same architectural seam: the frozen
// `BankStatement.rawPayload` IS the source of truth for the export.
//
// Difference from revenue-rec's pattern: recon's `BankStatement` uses
// `rawPayload: String` (not `sourcePayload: Json` like RevenueContract).
// The orchestrator stored the NS arrangement via `JSON.stringify(ns)`;
// the exporter parses it back.
//
// Also different: recon's `BankAccount` has no `sourcePayload` field.
// To reconstruct the NS bank-account references that statements link
// to, we walk BankAccount rows where `code` starts with "NS-BANK-"
// (the convention from the orchestrator) and reverse-derive the NS
// internalid by stripping the prefix.
//
// Lineage break safety: if a statement's filename doesn't start with
// "ns-" (i.e., it was uploaded as CSV/OFX, not imported from NS), the
// statement is skipped from the export. A bank account that has no
// NS-prefixed statements is also skipped — there's no NS arrangement
// to belong to.

import type { PrismaClient } from "@prisma/client";
import type {
  NsBankAccount,
  NsBankStatement,
  NsReconExport,
} from "./types";

// =========================================================================
// Public input + output shapes
// =========================================================================

export interface ExportToNsReconInput {
  /**
   * Scope the export to a specific tenant. CC6.1: explicit input
   * means cross-tenant misuse shows up at the call site. The exporter
   * never reads tenant state — the caller supplies the id from
   * `requireCurrentTenant()`.
   *
   * Tenant scoping: each BankAccount → LegalEntity has a tenantId;
   * the filter is `bankAccount: { entity: { tenantId } }`.
   */
  tenantId: string;
  /**
   * Optional override for the bundle's `exported_at` timestamp.
   * When omitted, uses the current time.
   */
  exportedAt?: Date;
  /**
   * Optional override for `account_id` on the exported bundle (the
   * NS account id the export "represents"). Defaults to a
   * "(unspecified)" placeholder.
   */
  accountId?: string;
}

export interface ExportToNsReconResult {
  /** The reassembled NS export bundle. */
  bundle: NsReconExport;
  /** How many statements went into the bundle. */
  statementCount: number;
  /** How many bank accounts the bundle references. */
  bankAccountCount: number;
  /** Warnings (e.g., "N statements skipped — non-NS filename"). */
  warnings: string[];
}

// =========================================================================
// Exporter
// =========================================================================

/**
 * Reassemble an NS bank-reconciliation export bundle from recon's
 * substrate. Reads BankStatement rows whose filename starts with
 * `ns-{internalid}.json` (the convention from the orchestrator);
 * parses the JSON-stringified rawPayload back to a typed
 * NsBankStatement; harvests the referenced bank accounts and
 * reconstructs NsBankAccount entries from BankAccount.code
 * (stripping the `NS-BANK-` prefix to recover the NS internalid).
 *
 * Tenant scoping enforced at the BankAccount → LegalEntity level —
 * a foreign tenant's data is invisible regardless of filename.
 *
 * @param prisma - Prisma client (typically the recon singleton)
 * @param input - tenant scope + optional metadata overrides
 * @returns The reassembled bundle + counts + warnings
 */
export async function exportToNsRecon(
  prisma: PrismaClient,
  input: ExportToNsReconInput
): Promise<ExportToNsReconResult> {
  const warnings: string[] = [];

  // Find all NS-imported BankStatement rows for this tenant. The
  // filename convention "ns-{internalid}.json" doubles as the lineage
  // marker since BankStatement has no first-class lineage triple
  // columns.
  const statementRows = await prisma.bankStatement.findMany({
    where: {
      filename: { startsWith: "ns-" },
      bankAccount: { entity: { tenantId: input.tenantId } },
    },
    select: {
      id: true,
      filename: true,
      rawPayload: true,
      bankAccountId: true,
    },
    orderBy: { id: "asc" },
  });

  // Reconstitute the statements + collect the bank-account ids we need.
  const statements: NsBankStatement[] = [];
  const referencedBankAccountIds = new Set<string>();
  let parseFailureCount = 0;

  for (const row of statementRows) {
    if (!row.rawPayload) {
      parseFailureCount += 1;
      continue;
    }
    try {
      const ns = JSON.parse(row.rawPayload) as NsBankStatement;
      statements.push(ns);
      referencedBankAccountIds.add(row.bankAccountId);
    } catch {
      parseFailureCount += 1;
    }
  }

  if (parseFailureCount > 0) {
    warnings.push(
      `Skipped ${parseFailureCount} BankStatement row(s) with missing or invalid rawPayload JSON. These rows can't be exported back — the lineage is broken.`
    );
  }

  // Reconstruct NsBankAccount entries from the referenced BankAccounts.
  // BankAccount.code is "NS-BANK-{internalid}"; strip the prefix.
  const bankAccountRows =
    referencedBankAccountIds.size > 0
      ? await prisma.bankAccount.findMany({
          where: {
            id: { in: Array.from(referencedBankAccountIds) },
            entity: { tenantId: input.tenantId },
          },
          select: {
            code: true,
            displayName: true,
            currencyId: true,
            entity: { select: { code: true } },
            account: { select: { sourceRecordId: true } },
          },
        })
      : [];

  const bankAccounts: NsBankAccount[] = [];
  let prefixViolationCount = 0;

  for (const row of bankAccountRows) {
    if (!row.code.startsWith("NS-BANK-")) {
      prefixViolationCount += 1;
      continue;
    }
    const nsInternalId = row.code.slice("NS-BANK-".length);
    bankAccounts.push({
      internalid: nsInternalId,
      name: row.displayName,
      gl_account_id: {
        // If the GL Account was bootstrapped via ledger-core's NS
        // mapper, its sourceRecordId holds the NS internalid. When
        // absent (e.g., the account was created manually), we fall
        // back to the BankAccount's accountId (a uuid — not a roundtrip-
        // true reconstruction; flagged as a warning below).
        internalid: row.account.sourceRecordId ?? "(unresolved)",
      },
      // Subsidiary internalid is similarly resolved through the
      // LegalEntity's code (NSSUB-{internalid} convention). If the
      // entity wasn't bootstrapped via NS, we emit "(unresolved)".
      subsidiary: {
        internalid: row.entity.code.startsWith("NSSUB-")
          ? row.entity.code.slice("NSSUB-".length)
          : "(unresolved)",
      },
      currency: row.currencyId,
    });
  }

  if (prefixViolationCount > 0) {
    warnings.push(
      `Skipped ${prefixViolationCount} BankAccount row(s) whose code doesn't start with "NS-BANK-". These were referenced by NS-imported statements but weren't themselves bootstrapped via NS.`
    );
  }

  const unresolvedGlAccounts = bankAccounts.filter(
    (b) => b.gl_account_id.internalid === "(unresolved)"
  ).length;
  if (unresolvedGlAccounts > 0) {
    warnings.push(
      `${unresolvedGlAccounts} bank account(s) reference a GL Account that wasn't NS-bootstrapped. Emitted gl_account_id.internalid='(unresolved)' — the export bundle is not fully roundtrip-true.`
    );
  }

  const unresolvedSubsidiaries = bankAccounts.filter(
    (b) => b.subsidiary.internalid === "(unresolved)"
  ).length;
  if (unresolvedSubsidiaries > 0) {
    warnings.push(
      `${unresolvedSubsidiaries} bank account(s) reference a LegalEntity that wasn't NS-bootstrapped (code doesn't start with "NSSUB-"). Emitted subsidiary.internalid='(unresolved)'.`
    );
  }

  const bundle: NsReconExport = {
    exported_at: (input.exportedAt ?? new Date()).toISOString(),
    account_id: input.accountId ?? "(unspecified)",
    bank_accounts: bankAccounts.sort((a, b) =>
      a.internalid.localeCompare(b.internalid)
    ),
    statements: statements.sort((a, b) =>
      a.internalid.localeCompare(b.internalid)
    ),
  };

  return {
    bundle,
    statementCount: statements.length,
    bankAccountCount: bankAccounts.length,
    warnings,
  };
}

// =========================================================================
// Roundtrip diff helper
// =========================================================================

/**
 * Compute a structural diff between an original NS bank-reconciliation
 * export and a re-exported one. Mirrors `diffNsRevenueExports` from
 * revenue-rec.
 *
 * Returns a list of human-readable differences. Empty array means
 * roundtrip-equal under documented exemptions:
 *   - `exported_at` (changes on every re-export)
 *   - Reconciliations[] (not included in export today)
 *   - "(unresolved)" placeholders when the original GL Account /
 *     subsidiary wasn't bootstrapped via the universal NS mapper
 *
 * Compares SEMANTIC equality on key fields (same approach as
 * revenue-rec's diff) rather than BYTE equality.
 */
export function diffNsReconExports(
  original: NsReconExport,
  reExported: NsReconExport
): string[] {
  const diffs: string[] = [];

  // Statement count.
  if (original.statements.length !== reExported.statements.length) {
    diffs.push(
      `statement count: original=${original.statements.length}, re-exported=${reExported.statements.length}`
    );
  }

  // Each original statement must reappear with all key fields preserved.
  const reExportedStmtById = new Map(
    reExported.statements.map((s) => [s.internalid, s])
  );
  for (const orig of original.statements) {
    const reExp = reExportedStmtById.get(orig.internalid);
    if (!reExp) {
      diffs.push(`statement ${orig.internalid}: missing from re-export`);
      continue;
    }
    const semanticDiffs: string[] = [];
    if (orig.bank_account.internalid !== reExp.bank_account.internalid)
      semanticDiffs.push(`bank_account.internalid`);
    if (orig.opening_balance !== reExp.opening_balance)
      semanticDiffs.push(`opening_balance`);
    if (orig.closing_balance !== reExp.closing_balance)
      semanticDiffs.push(`closing_balance`);
    if (orig.lines.length !== reExp.lines.length)
      semanticDiffs.push(`lines.length`);
    for (let i = 0; i < Math.min(orig.lines.length, reExp.lines.length); i += 1) {
      const ol = orig.lines[i];
      const rl = reExp.lines[i];
      if (ol.internalid !== rl.internalid)
        semanticDiffs.push(`lines[${i}].internalid`);
      if (ol.amount !== rl.amount) semanticDiffs.push(`lines[${i}].amount`);
      if (ol.matched_transaction_id !== rl.matched_transaction_id)
        semanticDiffs.push(`lines[${i}].matched_transaction_id`);
      if (ol.matched_transaction_type !== rl.matched_transaction_type)
        semanticDiffs.push(`lines[${i}].matched_transaction_type`);
    }
    if (semanticDiffs.length > 0) {
      diffs.push(
        `statement ${orig.internalid}: semantic mismatch on [${semanticDiffs.join(", ")}]`
      );
    }
  }

  // Bank account internalids should all reappear (modulo "(unresolved)" placeholders).
  const reExportedBaIds = new Set(
    reExported.bank_accounts.map((b) => b.internalid)
  );
  for (const orig of original.bank_accounts) {
    if (!reExportedBaIds.has(orig.internalid)) {
      diffs.push(`bank_account ${orig.internalid}: missing from re-export`);
    }
  }

  return diffs;
}
