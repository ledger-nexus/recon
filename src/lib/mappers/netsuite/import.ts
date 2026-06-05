// NetSuite bank-reconciliation import orchestrator.
//
// Idempotent end-to-end. Takes a parsed NS export bundle + resolver
// callbacks, writes the mapped `BankAccount` + `BankStatement` +
// `BankStatementLine` + `ReconciliationMatch` rows to recon's
// substrate, and surfaces per-statement warnings from the pure mappers.
//
// Idempotency: every BankStatement carries the lineage triple
// `(sourceSystem='netsuite', sourceRecordType='BankStatement',
// sourceRecordId=NS internalid)`. Note: BankStatement doesn't have
// these columns directly — we use `filename` as the dedup key
// (format: `ns-{internalid}.json`). A repeat import returns
// wasDuplicate: true; no rows written.
//
// Transactional discipline: each statement's BankStatement + all lines
// + all pre-existing matches land in a single `$transaction`. Per-
// statement try/catch isolates failures so a bad row doesn't sink
// the whole import.
//
// Resolver callbacks:
//
//   - `resolveEntityId({ nsSubsidiaryInternalId })`
//       → recon's LegalEntity.id. Throws when the subsidiary hasn't
//       been bootstrapped via ledger-core's universal NS mapper.
//
//   - `resolveBankGlAccountId({ nsGlAccountInternalId })`
//       → recon's Account.id (mirror of ledger-core's Account row).
//       Resolves the bank GL account by lineage triple.
//
//   - `resolveJournalLineId({ matchedTransactionType, matchedTransactionInternalId })`
//       → JournalLine.id when a NS bank-line match resolves to a GL
//       line via lineage triple (sourceSystem='netsuite',
//       sourceRecordType=matchedTransactionType,
//       sourceRecordId=matchedTransactionInternalId). Returns null
//       when the GL document hasn't been imported yet — the
//       orchestrator skips that match with a warning rather than
//       blocking the whole statement.

import type { PrismaClient } from "@prisma/client";
import {
  mapBankAccount,
  mapStatement,
  type MappedBankAccount,
  type MappedBankStatement,
  type MappedLineMatch,
} from "./mappers";
import type {
  NsReconExport,
  NsBankStatement,
  NsBankAccount,
} from "./types";

// =========================================================================
// Public input + result shapes
// =========================================================================

export interface ImportFromNsReconInput {
  /** The NS export bundle (bank accounts + statements + reconciliations). */
  export: NsReconExport;

  /**
   * Resolve a recon LegalEntity id from the NS subsidiary's internal
   * id. The orchestrator does NOT auto-create LegalEntities — those
   * are bootstrapped via ledger-core's universal NetSuite mapper.
   * Returns empty string when not bootstrapped; the orchestrator
   * surfaces an actionable per-statement error.
   */
  resolveEntityId: (args: {
    nsSubsidiaryInternalId: string;
  }) => Promise<string>;

  /**
   * Resolve a recon Account id (the GL substrate's bank account row)
   * from the NS GL account's internal id. Looks up by lineage triple
   * against the ledger-core-mirrored Account table.
   * Returns empty string when not bootstrapped.
   */
  resolveBankGlAccountId: (args: {
    nsGlAccountInternalId: string;
  }) => Promise<string>;

  /**
   * Resolve a JournalLine id from an NS matched_transaction reference.
   * The resolver queries the lineage triple on JournalEntry +
   * JournalLine; the JournalLine.id is what `ReconciliationMatch`
   * references.
   *
   * Returns null when the GL document hasn't been imported yet. The
   * orchestrator surfaces a per-line warning and skips that match —
   * the bank line still lands; just no ReconciliationMatch is created.
   * On a follow-up import after the GL document is bootstrapped, a
   * separate reconciliation pass would create the match.
   */
  resolveJournalLineId: (args: {
    matchedTransactionType: string;
    matchedTransactionInternalId: string;
  }) => Promise<string | null>;
}

export interface ImportStatementResult {
  nsStatementInternalId: string;
  /** recon's BankStatement.id. Always set (even when duplicate). */
  bankStatementId: string;
  /** True if the filename-based dedup matched an existing row. */
  wasDuplicate: boolean;
  /** Number of bank lines created (0 when wasDuplicate). */
  linesCreated: number;
  /** Number of pre-existing matches created (0 when wasDuplicate). */
  matchesCreated: number;
  /** Number of matches the resolver could not resolve (no JE yet). */
  matchesSkipped: number;
  /** Mapper warnings + per-line resolution warnings. */
  warnings: string[];
}

export interface ImportFromNsReconResult {
  arrangements: never[]; // reserved
  /** Per-statement success records. */
  statements: ImportStatementResult[];
  /** Per-statement errors (mapping or DB failure). */
  errors: Array<{
    nsStatementInternalId: string;
    message: string;
  }>;
  /** Totals for the operator/UI. */
  totals: {
    statementsProcessed: number;
    statementsCreated: number;
    statementsSkipped: number;
    statementsErrored: number;
    linesCreated: number;
    matchesCreated: number;
    matchesSkipped: number;
    warningCount: number;
  };
}

// =========================================================================
// Orchestrator
// =========================================================================

/**
 * Import an NS bank-reconciliation export into recon.
 *
 * Per-statement flow:
 *   1. Resolve LegalEntity (throws → per-statement error).
 *   2. Resolve bank GL Account (throws → per-statement error).
 *   3. Upsert BankAccount keyed by NS-BANK-{internalid} code.
 *   4. Check filename-based idempotency (`ns-{internalid}.json`).
 *      If exists, SKIP and return wasDuplicate.
 *   5. mapStatement() → MappedBankStatement + lineMatches[].
 *   6. Resolve each lineMatch's journalLineId via the resolver. Drop
 *      matches that can't be resolved (warning) — lines still land.
 *   7. Single $transaction: create BankStatement + nested lines, then
 *      ReconciliationMatch rows for resolved matches.
 *   8. Surface mapper warnings + per-line resolution warnings.
 */
export async function importFromNsRecon(
  prisma: PrismaClient,
  input: ImportFromNsReconInput
): Promise<ImportFromNsReconResult> {
  // Build a bank-account lookup so we can validate statement references.
  const bankAccountsByInternalId = new Map(
    input.export.bank_accounts.map((b) => [b.internalid, b])
  );

  const statements: ImportStatementResult[] = [];
  const errors: ImportFromNsReconResult["errors"] = [];
  let totalLines = 0;
  let totalMatches = 0;
  let totalSkipped = 0;
  let totalWarnings = 0;

  for (const ns of input.export.statements) {
    try {
      const result = await importOneStatement(prisma, ns, bankAccountsByInternalId, input);
      statements.push(result);
      totalLines += result.linesCreated;
      totalMatches += result.matchesCreated;
      totalSkipped += result.matchesSkipped;
      totalWarnings += result.warnings.length;
    } catch (e) {
      errors.push({
        nsStatementInternalId: ns.internalid,
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  return {
    arrangements: [],
    statements,
    errors,
    totals: {
      statementsProcessed: input.export.statements.length,
      statementsCreated: statements.filter((s) => !s.wasDuplicate).length,
      statementsSkipped: statements.filter((s) => s.wasDuplicate).length,
      statementsErrored: errors.length,
      linesCreated: totalLines,
      matchesCreated: totalMatches,
      matchesSkipped: totalSkipped,
      warningCount: totalWarnings,
    },
  };
}

/**
 * Import a single statement. Throws on hard failures (missing bank
 * account in the bundle, missing entity / GL account); the caller
 * catches per-statement so a bad row doesn't sink the import.
 */
async function importOneStatement(
  prisma: PrismaClient,
  ns: NsBankStatement,
  bankAccountsByInternalId: Map<string, NsBankAccount>,
  input: ImportFromNsReconInput
): Promise<ImportStatementResult> {
  // 1. Validate the statement's bank account reference.
  const bankAccountNs = bankAccountsByInternalId.get(ns.bank_account.internalid);
  if (!bankAccountNs) {
    throw new Error(
      `Statement ${ns.internalid} references bank_account ${ns.bank_account.internalid}, which is not in the export bundle's bank_accounts[].`
    );
  }

  // 2. Resolve LegalEntity.
  const entityId = await input.resolveEntityId({
    nsSubsidiaryInternalId: bankAccountNs.subsidiary.internalid,
  });
  if (!entityId) {
    throw new Error(
      `Could not resolve LegalEntity for NS subsidiary internalid=${bankAccountNs.subsidiary.internalid}. Bootstrap this subsidiary via ledger-core's NS mapper first.`
    );
  }

  // 3. Resolve bank GL Account.
  const glAccountId = await input.resolveBankGlAccountId({
    nsGlAccountInternalId: bankAccountNs.gl_account_id.internalid,
  });
  if (!glAccountId) {
    throw new Error(
      `Could not resolve bank GL Account for NS internalid=${bankAccountNs.gl_account_id.internalid}. Bootstrap accounts via ledger-core's NS mapper first.`
    );
  }

  // 4. Upsert BankAccount keyed by code (NS-BANK-{internalid}).
  const mappedBankAccount = mapBankAccount(bankAccountNs);
  const bankAccount = await prisma.bankAccount.upsert({
    where: { code: mappedBankAccount.code },
    create: {
      code: mappedBankAccount.code,
      displayName: mappedBankAccount.displayName,
      entityId,
      accountId: glAccountId,
      currencyId: mappedBankAccount.currency,
    },
    update: {
      displayName: mappedBankAccount.displayName,
    },
    select: { id: true },
  });

  // 5. Idempotency: filename-based check against recon's BankStatement.
  // (BankStatement has no first-class sourceRecordId column; filename
  // is the natural dedup key for NS imports.)
  const filename = `ns-${ns.internalid}.json`;
  const existing = await prisma.bankStatement.findFirst({
    where: { bankAccountId: bankAccount.id, filename },
    select: { id: true },
  });
  if (existing) {
    return {
      nsStatementInternalId: ns.internalid,
      bankStatementId: existing.id,
      wasDuplicate: true,
      linesCreated: 0,
      matchesCreated: 0,
      matchesSkipped: 0,
      warnings: [],
    };
  }

  // 6. Pure mapping.
  const { statement: mapped, warnings: mapperWarnings } = mapStatement(ns);

  // 7. Resolve pre-existing matches via the lineage-triple resolver.
  const resolvedMatches: Array<{
    bankLineSourceRecordId: string;
    journalLineId: string;
    source: "MANUAL";
    status: "APPROVED";
  }> = [];
  const matchWarnings: string[] = [];
  let skippedMatchCount = 0;

  for (const lineMatch of mapped.lineMatches) {
    const journalLineId = await input.resolveJournalLineId({
      matchedTransactionType: lineMatch.matchedTransactionType,
      matchedTransactionInternalId: lineMatch.matchedTransactionInternalId,
    });
    if (!journalLineId) {
      skippedMatchCount += 1;
      matchWarnings.push(
        `Statement ${ns.internalid}, line ${lineMatch.bankLineSourceRecordId}: could not resolve ${lineMatch.matchedTransactionType} ${lineMatch.matchedTransactionInternalId} to a JournalLine. GL document not yet imported.`
      );
      continue;
    }
    resolvedMatches.push({
      bankLineSourceRecordId: lineMatch.bankLineSourceRecordId,
      journalLineId,
      source: "MANUAL",
      status: "APPROVED",
    });
  }

  // 8. Write everything in one transaction.
  const result = await prisma.$transaction(async (tx) => {
    const matchedLineCount = resolvedMatches.length;
    const pendingLineCount = mapped.lines.length - matchedLineCount;
    const stmt = await tx.bankStatement.create({
      data: {
        bankAccountId: bankAccount.id,
        filename,
        format: mapped.format,
        rawPayload: JSON.stringify(ns),
        periodStart: new Date(mapped.periodStart),
        periodEnd: new Date(mapped.periodEnd),
        openingBalance: mapped.openingBalance.toFixed(4),
        closingBalance: mapped.closingBalance.toFixed(4),
        totalLines: mapped.lines.length,
        matchedLines: matchedLineCount,
        pendingLines: pendingLineCount,
        lines: {
          create: mapped.lines.map((l) => ({
            lineNo: l.lineNo,
            transactionDate: new Date(l.transactionDate),
            description: l.description,
            amount: l.amount.toFixed(4),
            externalRef: l.externalRef ?? null,
            status: lineHasMatch(resolvedMatches, l.sourceRecordId)
              ? "MATCHED"
              : "UNMATCHED",
          })),
        },
      },
      select: { id: true, lines: { select: { id: true, lineNo: true } } },
    });

    // Create ReconciliationMatch rows. We need the line ids; the
    // create above returned them. Match lineNo ↔ sourceRecordId by
    // order-preserving lookup.
    const lineIdByLineNo = new Map(stmt.lines.map((l) => [l.lineNo, l.id]));
    const lineIdBySourceRecordId = new Map<string, string>();
    mapped.lines.forEach((l) => {
      const id = lineIdByLineNo.get(l.lineNo);
      if (id) lineIdBySourceRecordId.set(l.sourceRecordId, id);
    });

    for (const m of resolvedMatches) {
      const bankLineId = lineIdBySourceRecordId.get(m.bankLineSourceRecordId);
      if (!bankLineId) {
        // Defensive — shouldn't happen.
        continue;
      }
      await tx.reconciliationMatch.create({
        data: {
          bankLineId,
          journalLineId: m.journalLineId,
          source: m.source,
          status: m.status,
          approvedAt: new Date(),
        },
      });
    }

    return stmt;
  });

  return {
    nsStatementInternalId: ns.internalid,
    bankStatementId: result.id,
    wasDuplicate: false,
    linesCreated: mapped.lines.length,
    matchesCreated: resolvedMatches.length,
    matchesSkipped: skippedMatchCount,
    warnings: [...mapperWarnings, ...matchWarnings],
  };
}

function lineHasMatch(
  matches: Array<{ bankLineSourceRecordId: string }>,
  sourceRecordId: string
): boolean {
  return matches.some((m) => m.bankLineSourceRecordId === sourceRecordId);
}
