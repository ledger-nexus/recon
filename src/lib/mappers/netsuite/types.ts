// NetSuite bank reconciliation export shape types.
//
// Hand-rolled from the NetSuite SuiteScript record JSON shape + the
// field inventory documented in ledger-core's
// `docs/reference/netsuite-recon-validation.md`.
//
// Naming conventions match NS:
//   - `internalid` / `externalid` are the NS-side identifiers
//   - snake_case throughout (NS API style)
//   - `custcol_*` are custom column fields on lines
//
// The KEY model difference vs recon (per the validation doc):
//
//   NetSuite stores matches DENORMALIZED on the bank statement line:
//     bank_statement_line.matched_transaction_type   (payment/bill_payment/...)
//     bank_statement_line.matched_transaction_id     (the GL document id)
//     bank_statement_line.reconciled                 (boolean)
//
//   recon stores matches NORMALIZED in `ReconciliationMatch`:
//     - one row per (bankLineId, journalLineId) pair
//     - MatchSource enum (DETERMINISTIC / AI / MANUAL)
//     - MatchStatus enum (PROPOSED / APPROVED / REJECTED / WITHDRAWN)
//
//   Translation rule (per validation doc):
//     A NetSuite line WITH matched_transaction_id →
//       ReconciliationMatch { source: MANUAL, status: APPROVED, ... }
//     A NetSuite line WITHOUT a match →
//       just the BankStatementLine row; recon's matcher proposes
//       new matches downstream.
//
// The matched_transaction_id → journalLineId resolution requires the
// GL import to have run first (lineage triple lookup). This mapper
// captures the NS data verbatim; the resolver callback in the
// orchestrator (PR #2 of this sprint) does the resolution.

/** Reference to another NS record by internalid + optional display name. */
export interface NsRef {
  internalid: string;
  name?: string;
}

// =========================================================================
// Bank account translation
// =========================================================================

/**
 * NetSuite bank account. Maps to recon's `BankAccount`.
 *
 * `gl_account_id` is the link to the GL substrate (the NS Account record).
 * This must already be bootstrapped by ledger-core's NS Account import
 * before a bank account can be created (the resolver callback queries
 * by lineage triple).
 */
export interface NsBankAccount {
  internalid: string;
  /** Display name shown in the NS UI ("Chase Operating ****1234"). */
  name: string;
  /** Reference to the NS GL Account this bank account is on. */
  gl_account_id: NsRef;
  /** Subsidiary (multi-sub deployments). */
  subsidiary: NsRef;
  /** ISO 4217. */
  currency: string;
  /** Last reconciliation snapshot (informational; not modeled in recon). */
  last_reconciled_date?: string | null;
  /** Denormalized current balance (informational; recon computes on read). */
  current_balance?: number | null;
}

// =========================================================================
// Bank statement + line translation
// =========================================================================

/**
 * NetSuite bank statement. Maps to recon's `BankStatement`.
 */
export interface NsBankStatement {
  internalid: string;
  /** NS document number. */
  tranid?: string;
  /** Reference to the bank account this statement is for. */
  bank_account: NsRef;
  /** ISO date — statement period start. */
  period_start: string;
  /** ISO date — statement period end. */
  period_end: string;
  /** Opening balance (signed). */
  opening_balance: number;
  /** Closing balance (signed). */
  closing_balance: number;
  /** ISO 4217. NS stores per-statement; recon's model inherits from BankAccount. */
  currency: string;
  /** All lines on this statement. */
  lines: NsBankStatementLine[];
}

/**
 * NetSuite bank statement line. Maps to recon's `BankStatementLine`.
 *
 * The matched_transaction_* fields are the DENORMALIZED match — when
 * present, the line was already reconciled in NS. The mapper produces
 * a paired `ReconciliationMatch` with `source: MANUAL, status: APPROVED`
 * (per the validation doc translation rule).
 */
export interface NsBankStatementLine {
  internalid: string;
  /** 1-based sequence on the statement. */
  line_no: number;
  /** ISO date — when the bank posted the transaction. */
  transaction_date: string;
  /** Free-form description from the bank feed. */
  description: string;
  /**
   * SIGNED amount. Positive = inflow (deposit), negative = outflow
   * (withdrawal). Same convention as recon's `BankStatementLine.amount`.
   */
  amount: number;
  /** Stable external id from the bank feed (Plaid txn id / file checksum). */
  external_ref?: string;
  /**
   * Denormalized match: the GL document type this line matched to.
   * Common values: "payment", "bill_payment", "bank_transfer",
   * "cash_refund", "deposit". Null when the line is unmatched.
   */
  matched_transaction_type?:
    | "payment"
    | "bill_payment"
    | "bank_transfer"
    | "cash_refund"
    | "deposit"
    | "journal_entry"
    | "transfer"
    | string
    | null;
  /**
   * Denormalized match: the GL document's NS internal id. The recon
   * importer resolves this to a `JournalLine.id` via the lineage triple
   * (sourceSystem='netsuite', sourceRecordType=<the type>, sourceRecordId=<this id>).
   * Null when the line is unmatched.
   */
  matched_transaction_id?: string | null;
  /** True if NS considers this line reconciled. */
  reconciled?: boolean;
  /** Optional custom column fields. */
  custom_columns?: Record<string, string | number | boolean | null>;
}

// =========================================================================
// Reconciliation translation
// =========================================================================

/**
 * NetSuite reconciliation event. Maps to a closed/reviewed state in
 * recon's UI; recon doesn't have a first-class `Reconciliation` model
 * today (the statement-level "all resolved" badge serves this role).
 *
 * Captured here so the mapper can surface the reconciliation as
 * metadata + verify the line-level matched_transaction pointers are
 * internally consistent.
 */
export interface NsReconciliation {
  internalid: string;
  bank_account: NsRef;
  /** ISO date — the as-of date of the reconciliation. */
  reconciled_date: string;
  /** Statement balance the reconciler tied to. */
  reconciled_balance: number;
  /** User who performed the reconciliation. */
  reconciled_by?: NsRef;
  /** Bank statement internal ids covered by this reconciliation. */
  statement_ids: string[];
}

// =========================================================================
// Top-level export bundle
// =========================================================================

/**
 * A complete NS bank reconciliation export. The orchestrator (future
 * PR) consumes this; the pure mappers translate each record type
 * independently.
 */
export interface NsReconExport {
  /** When the NS export ran (ISO). */
  exported_at: string;
  /** NS account id the export came from (informational). */
  account_id: string;
  /** Bank accounts referenced by statements. */
  bank_accounts: NsBankAccount[];
  /** Bank statements + their lines. */
  statements: NsBankStatement[];
  /** Reconciliation events (informational + audit-trail). */
  reconciliations?: NsReconciliation[];
}
