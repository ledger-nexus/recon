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
//   to the tenant's books.
//
// Why this is a typed stub today:
//   The actual implementation is gated on the first real DSR arriving.
//   Until then the wiring point is reserved + the contract is
//   documented in the type. The DSR procedure in
//   `docs/policies/data-subject-requests.md` is the auditor-facing
//   commitment; this file is the code-side commitment.

import type { PrismaClient } from "@prisma/client";

/**
 * Attribution counts for a user across recon's tables.
 *
 * Stable schema — once shipped, ledger-core's export bundle will
 * persist these counts. Bumping the version (e.g. adding a new
 * count column) is a backwards-compatible change as long as
 * existing fields keep their meaning.
 */
export interface ReconAttribution {
  /**
   * Bank statements the subject (as ADMIN+) uploaded. Counts the
   * `BankStatement` rows whose attribution chain ends at this
   * userId. Does NOT include statement contents (those are tenant
   * data, preserved on erasure).
   */
  bankStatementsUploaded: number;
  /**
   * Reconciliation matches the subject approved. Counts the
   * `ReconciliationMatch.approvedByUserId` rows. The matches
   * themselves stay (tenant data); only the count is returned.
   */
  reconciliationMatchesApproved: number;
  /**
   * AI suggestions the subject accepted or rejected. Counts
   * `AiSuggestion` rows attributable to the subject. The
   * suggestion bodies are encrypted at rest + preserved on
   * erasure under the 7-year AI-audit-trail retention window.
   */
  aiSuggestionsAccepted: number;
  aiSuggestionsRejected: number;
  /** When the count snapshot was taken. */
  snapshotAt: string;
}

/**
 * Assemble recon's attribution contribution to the portfolio-wide
 * DSR export bundle.
 *
 * Caller: `ledger-core/src/lib/privacy/user-data.ts buildUserDataExport()`.
 * Called via HTTP at a future `/api/internal/dsr/attribution` endpoint
 * — the canonical cross-repo write-boundary pattern (mirrors the
 * existing internal-journal-entries endpoint).
 *
 * Authorization: enforced at the calling Server Action layer in
 * ledger-core. This helper is the data-assembly seam, not the
 * authorization gate.
 *
 * @throws NotImplementedError — body not yet written. Triggered when
 *         the first real DSR arrives; tracked at
 *         `docs/policies/data-subject-requests.md` → "Open items".
 */
export async function reconAttribution(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  userId: string
): Promise<ReconAttribution> {
  throw new NotImplementedError(
    "reconAttribution is a typed stub. See " +
      "docs/policies/data-subject-requests.md → \"Open items\" for " +
      "the implementation trigger."
  );
}

/**
 * Distinct error class so a real-DSR caller can catch this specifically
 * vs. an unexpected error (e.g., DB outage) and surface the right
 * message to the privacy lead.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
