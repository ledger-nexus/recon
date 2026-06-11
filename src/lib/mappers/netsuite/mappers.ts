// Pure mapper functions for NetSuite bank reconciliation imports.
//
// No I/O, no DB access. Each function takes a verbatim NS shape and
// returns a `MappedBankAccount` / `MappedBankStatement` / typed
// match shape suitable for the import orchestrator (follow-up PR).
//
// THE LOAD-BEARING TRANSLATION (per validation doc):
//
//   NetSuite line with matched_transaction_id → one ReconciliationMatch
//     with source=MANUAL, status=APPROVED (the user already matched it
//     in NS; the import preserves that decision verbatim).
//
//   NetSuite line WITHOUT a match → just the BankStatementLine row;
//     recon's downstream matcher proposes new matches.
//
// The matched_transaction_id → journalLineId resolution happens in the
// orchestrator's resolver callback (queries the lineage triple). This
// pure mapper captures the source data; the orchestrator does the
// FK resolution.

import type {
  NsBankAccount,
  NsBankStatement,
  NsBankStatementLine,
} from "./types";

// =========================================================================
// Output shapes — what the importer writes to recon's substrate
// =========================================================================

export type MatchSource = "DETERMINISTIC" | "AI" | "MANUAL";
export type MatchStatus = "PROPOSED" | "APPROVED" | "REJECTED" | "WITHDRAWN";

export interface MappedBankAccount {
  /** recon's BankAccount.code; convention "NS-BANK-{internalid}". */
  code: string;
  displayName: string;
  /** Resolved at orchestrator time via lineage triple lookup against ledger-core. */
  nsGlAccountInternalId: string;
  nsSubsidiaryInternalId: string;
  currency: string;
  sourceSystem: "netsuite";
  sourceRecordType: "BankAccount";
  sourceRecordId: string;
  sourcePayload: NsBankAccount;
  mappingVersion: string;
}

export interface MappedBankStatement {
  /** recon's BankStatement.format; one of the recon vocabulary. */
  format: "NETSUITE_EXPORT";
  /** Filename surrogate ("ns-{internalid}.json"). */
  filename: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: number;
  closingBalance: number;
  /** All lines on this statement (no nested matches — see `lineMatches[]`). */
  lines: MappedBankStatementLine[];
  /**
   * Pre-existing matches surfaced by NS denormalized fields. One entry
   * per line that had matched_transaction_id populated. The orchestrator
   * resolves the journalLineId via lineage triple lookup against
   * ledger-core's JournalLine table.
   */
  lineMatches: MappedLineMatch[];
  sourceSystem: "netsuite";
  sourceRecordType: "BankStatement";
  sourceRecordId: string;
  sourcePayload: NsBankStatement;
  mappingVersion: string;
}

export interface MappedBankStatementLine {
  /** 1-based ordering. */
  lineNo: number;
  transactionDate: string;
  description: string;
  /** Signed: positive = inflow, negative = outflow. */
  amount: number;
  /** Stable external id (bank feed dedup key). May be the NS line internalid. */
  externalRef?: string;
  sourceRecordId: string;
}

/**
 * Pre-existing match surfaced by NS's denormalized columns. Paired
 * to a specific `MappedBankStatementLine` by `sourceRecordId`. The
 * orchestrator turns each of these into a `ReconciliationMatch` row
 * with `source=MANUAL, status=APPROVED`.
 */
export interface MappedLineMatch {
  /** The bank-line's source record id (also = NS line internalid). */
  bankLineSourceRecordId: string;
  /** NS GL document type (payment / bill_payment / journal_entry / ...). */
  matchedTransactionType: string;
  /** NS GL document internal id — the orchestrator resolves to a JournalLine. */
  matchedTransactionInternalId: string;
  /** Always MANUAL: NS user already matched it. */
  source: "MANUAL";
  /** Always APPROVED: NS considers it reconciled. */
  status: "APPROVED";
}

export interface MappedReconImport {
  bankAccount: MappedBankAccount;
  statement: MappedBankStatement;
  warnings: string[];
}

// =========================================================================
// Mapping version
// =========================================================================

export const NS_RECON_MAPPING_VERSION = "1.0.0";

// =========================================================================
// Bank account mapper
// =========================================================================

/**
 * Translate an NS bank account to recon's `MappedBankAccount` shape.
 * The `gl_account_id` resolution to a real `Account` row happens in
 * the orchestrator (looks up by lineage triple).
 */
export function mapBankAccount(ns: NsBankAccount): MappedBankAccount {
  return {
    code: `NS-BANK-${ns.internalid}`,
    displayName: ns.name,
    nsGlAccountInternalId: ns.gl_account_id.internalid,
    nsSubsidiaryInternalId: ns.subsidiary.internalid,
    currency: ns.currency,
    sourceSystem: "netsuite",
    sourceRecordType: "BankAccount",
    sourceRecordId: ns.internalid,
    sourcePayload: ns,
    mappingVersion: NS_RECON_MAPPING_VERSION,
  };
}

// =========================================================================
// Statement line mapper
// =========================================================================

/**
 * Translate a single NS statement line. Returns the mapped line + an
 * optional pre-existing match (when `matched_transaction_id` is set).
 *
 * Per the validation doc, lines with matched_transaction_id are
 * recorded as MANUAL/APPROVED matches because NS users already
 * resolved them; the AI/DETERMINISTIC matcher would only re-propose.
 */
export function mapStatementLine(
  ns: NsBankStatementLine
): {
  line: MappedBankStatementLine;
  match: MappedLineMatch | null;
} {
  const line: MappedBankStatementLine = {
    lineNo: ns.line_no,
    transactionDate: ns.transaction_date,
    description: ns.description,
    amount: ns.amount,
    externalRef: ns.external_ref ?? ns.internalid,
    sourceRecordId: ns.internalid,
  };

  // No match: just the line.
  if (
    !ns.matched_transaction_id ||
    !ns.matched_transaction_type
  ) {
    return { line, match: null };
  }

  const match: MappedLineMatch = {
    bankLineSourceRecordId: ns.internalid,
    matchedTransactionType: ns.matched_transaction_type,
    matchedTransactionInternalId: ns.matched_transaction_id,
    source: "MANUAL",
    status: "APPROVED",
  };

  return { line, match };
}

// =========================================================================
// Statement mapper
// =========================================================================

/**
 * Translate a full NS bank statement (lines + denormalized matches)
 * to recon's input shape. The orchestrator takes this output and
 * resolves bank-account + journal-line FKs against the substrate.
 */
export function mapStatement(ns: NsBankStatement): {
  statement: MappedBankStatement;
  warnings: string[];
} {
  const warnings: string[] = [];

  const lines: MappedBankStatementLine[] = [];
  const lineMatches: MappedLineMatch[] = [];

  for (const lineNs of ns.lines) {
    const { line, match } = mapStatementLine(lineNs);
    lines.push(line);
    if (match) lineMatches.push(match);
  }

  // Sanity check: Σ amounts ≈ (closing - opening). Within penny tolerance.
  // Surface a warning on mismatch (likely a truncated dataset).
  const sumAmounts = lines.reduce((acc, l) => acc + l.amount, 0);
  const expectedDelta = ns.closing_balance - ns.opening_balance;
  if (Math.abs(sumAmounts - expectedDelta) > 0.01 && lines.length > 0) {
    warnings.push(
      `Statement ${ns.internalid}: Σ lines (${sumAmounts.toFixed(2)}) does not match closing - opening (${expectedDelta.toFixed(2)}). May be a partial dataset.`
    );
  }

  // Reconciliation sanity check: matched ratio (informational).
  // Only emit for statements with enough lines to be statistically
  // meaningful — a 0/1 or 0/2 ratio is noise (single-line statements
  // are normal in the wild, especially in early-month windows).
  if (lines.length >= 3) {
    const matchedRatio = lineMatches.length / lines.length;
    if (matchedRatio < 0.5) {
      warnings.push(
        `Statement ${ns.internalid}: only ${(matchedRatio * 100).toFixed(0)}% of lines have pre-existing matches. The remainder will need recon's matcher.`
      );
    }
  }

  const filename = `ns-${ns.internalid}.json`;

  const statement: MappedBankStatement = {
    format: "NETSUITE_EXPORT",
    filename,
    periodStart: ns.period_start,
    periodEnd: ns.period_end,
    openingBalance: ns.opening_balance,
    closingBalance: ns.closing_balance,
    lines,
    lineMatches,
    sourceSystem: "netsuite",
    sourceRecordType: "BankStatement",
    sourceRecordId: ns.internalid,
    sourcePayload: ns,
    mappingVersion: NS_RECON_MAPPING_VERSION,
  };

  return { statement, warnings };
}

// =========================================================================
// Full-import mapper
// =========================================================================

/**
 * Map a single (bank account, statement) pair. The orchestrator
 * (follow-up PR) calls this per statement and feeds the bank-account
 * resolver callback the mapped bank-account ahead of statement writes.
 */
export function mapForImport(
  bankAccountNs: NsBankAccount,
  statementNs: NsBankStatement
): MappedReconImport {
  if (statementNs.bank_account.internalid !== bankAccountNs.internalid) {
    throw new Error(
      `Statement ${statementNs.internalid} references bank_account ${statementNs.bank_account.internalid}, not ${bankAccountNs.internalid} as passed.`
    );
  }

  const bankAccount = mapBankAccount(bankAccountNs);
  const { statement, warnings } = mapStatement(statementNs);

  return { bankAccount, statement, warnings };
}
