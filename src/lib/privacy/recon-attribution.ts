// Recon-side attribution for the portfolio-wide DSR export bundle.
//
// Privacy TSC. Implements the contract described at
// `docs/policies/data-subject-requests.md` → "Right of access".
//
// This function is INVOKED FROM ledger-core's `buildUserDataExport()`
// when a subject's Article 15 request is being assembled. Recon is
// the canonical home for bank-statement + reconciliation data; this
// helper returns **attribution counts only**, never the underlying
// tenant data.
//
// Why counts and not contents:
//   Bank statements + match decisions are TENANT data. The subject's
//   relationship is "who uploaded the statement" or "who approved
//   the match" — an attribution edge, not personal data. GDPR Art.
//   15 grants the subject access to personal data ABOUT THEM, not
//   to the tenant's books. Statement contents (descriptions,
//   counterparty names) stay on erasure; the attribution columns
//   (uploadedBy, approvedBy, rejectedBy) are nulled.

import { MatchSource, MatchStatus, type PrismaClient } from "@prisma/client";

/**
 * Attribution counts for a user across recon's tables.
 *
 * Stable schema — ledger-core's export bundle persists these counts
 * verbatim. Adding a new top-level key is backwards-compatible as
 * long as existing fields keep their meaning.
 */
export interface ReconAttribution {
  /**
   * Bank statements the subject (as ADMIN+) uploaded. Counts the
   * `BankStatement` rows whose `uploadedBy` matches the subject's
   * user id. Does NOT include statement contents (those are tenant
   * data, preserved on erasure).
   */
  bankStatementsUploaded: number;
  /**
   * Reconciliation matches the subject approved. Counts
   * `ReconciliationMatch.approvedBy = userId` AND
   * `status = APPROVED`. Excludes WITHDRAWN matches the subject may
   * have approved first.
   */
  reconciliationMatchesApproved: number;
  /**
   * AI suggestions the subject accepted. A match with `source = AI`
   * and `status = APPROVED` and `approvedBy = userId` means the
   * subject approved an AI-proposed match — that's "accepted an AI
   * suggestion" semantically. Excludes manual + deterministic
   * approvals (counted in `reconciliationMatchesApproved`).
   */
  aiSuggestionsAccepted: number;
  /**
   * AI suggestions the subject rejected. Matches with `source = AI`,
   * `status = REJECTED`, and `rejectedBy = userId`. The suggestion
   * bodies are encrypted at rest + preserved on erasure under the
   * 7-year AI-audit-trail retention window — only the rejectedBy
   * attribution column is nulled.
   */
  aiSuggestionsRejected: number;
  /** When the count snapshot was taken (ISO 8601 UTC). */
  snapshotAt: string;
}

/**
 * Assemble recon's attribution contribution to the portfolio-wide
 * DSR export bundle.
 *
 * Caller: `ledger-core/src/lib/privacy/user-data.ts buildUserDataExport()`.
 * Called via HTTP at a future `/api/internal/dsr/attribution` endpoint
 * gated by `INTERNAL_API_TOKEN` — the canonical cross-repo write-
 * boundary pattern (mirrors the existing
 * `/api/internal/journal-entries` endpoint).
 *
 * Authorization: enforced at the calling Server Action layer in
 * ledger-core. This helper is the data-assembly seam, not the
 * authorization gate.
 *
 * Implementation: four queries in parallel via `Promise.all`. Each
 * is O(matches-of-user) or O(statements-of-user) with the indexed
 * selector being the attribution column. Status + source filters
 * are pushed to the WHERE clause so Postgres uses the
 * `reconciliation_match_status_idx` index where applicable.
 *
 * @param prisma - Prisma client (typically the recon singleton)
 * @param userId - Subject user UUID. Matched against `uploadedBy`,
 *                 `approvedBy`, and `rejectedBy` attribution columns.
 * @returns Attribution counts. Empty-but-valid shape if the subject
 *          has no recon activity.
 */
export async function reconAttribution(
  prisma: PrismaClient,
  userId: string
): Promise<ReconAttribution> {
  const [
    bankStatementsUploaded,
    reconciliationMatchesApproved,
    aiSuggestionsAccepted,
    aiSuggestionsRejected,
  ] = await Promise.all([
    prisma.bankStatement.count({
      where: { uploadedBy: userId },
    }),
    prisma.reconciliationMatch.count({
      where: { approvedBy: userId, status: MatchStatus.APPROVED },
    }),
    prisma.reconciliationMatch.count({
      where: {
        approvedBy: userId,
        status: MatchStatus.APPROVED,
        source: MatchSource.AI,
      },
    }),
    prisma.reconciliationMatch.count({
      where: {
        rejectedBy: userId,
        status: MatchStatus.REJECTED,
        source: MatchSource.AI,
      },
    }),
  ]);

  return {
    bankStatementsUploaded,
    reconciliationMatchesApproved,
    aiSuggestionsAccepted,
    aiSuggestionsRejected,
    snapshotAt: new Date().toISOString(),
  };
}

/**
 * Retained for backwards compatibility with the v0.1 typed-stub
 * tests + any caller that imported it during the stub era. Real
 * callers will not see this thrown — the implementation above is
 * now wired.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
