# Data subject request procedure — recon

**Owner:** Privacy lead (shared with the rest of the portfolio; see
`ledger-core/docs/policies/access-control.md`)
**Last reviewed:** 2026-06-02
**Defers to:** `ledger-core/docs/policies/data-subject-requests.md` — the
canonical, portfolio-wide procedure.

This document covers what's **unique to the `recon` repo**: the
reconciliation-specific data surfaces, and how a data-subject request
is honored against them. The general procedure (channels, identity
verification, SLA, audit-logging) lives in `ledger-core` and is NOT
duplicated here.

---

## What personal data this repo holds

### `User` + `Tenant` + `TenantMembership` (replicated)

These tables are FK-convenience replicas of the canonical rows in
`ledger-core`. The replica is **read-mostly**; the canonical writes
live in `ledger-core`. An erasure in `ledger-core` propagates to the
replica on the next sync cycle.

| Field | Classification | Notes |
|---|---|---|
| `User.email` | CONFIDENTIAL | Replica; encrypted at rest via the shared field-encryption extension. |
| `User.displayName` | CONFIDENTIAL | Replica; encrypted at rest. |
| `Tenant.name` | CONFIDENTIAL | Replica; encrypted at rest. |

### Reconciliation surfaces (tenant data with incidental PII)

These columns belong to the TENANT, not the subject. They may contain
incidental PII (counterparty names, payment references, vendor
identifiers) but are not personal data of any individual user. They
are preserved on subject erasure under Art. 17(3)(b/e) legal-retention
exemption.

| Field | Classification | Notes |
|---|---|---|
| `BankStatement.filename` | CONFIDENTIAL | Often encodes the tenant's bank name + account fragment. **Encrypted at rest** (PR-mirror from ledger-core). |
| `BankStatement.rawPayload` | CONFIDENTIAL | The original CSV/OFX bytes. **Encrypted at rest** (Json mode). |
| `BankStatementLine.description` | CONFIDENTIAL | Free-text payment memo from the bank — counterparty names, invoice numbers, etc. **Encrypted at rest**. |
| `BankAccount.{displayName, bankName, accountNumberLast4}` | CONFIDENTIAL | All three encrypted at rest. Last-4 is intentionally not enough to identify the account in isolation. |
| `Party.displayName` | CONFIDENTIAL | Counterparty (customer/vendor) names. **Encrypted at rest**. |
| `AiSuggestion.candidatesJson` | CONFIDENTIAL | AI's reasoning trace for a reconciliation match. **Encrypted at rest** (Json mode). |
| `JournalLine.description` | CONFIDENTIAL | Free-text line memo. Not encrypted (matches ledger-core's choice — heavily queried for reporting; defense is per-tenant scoping). |

### Reconciliation history (INTERNAL)

`ReconciliationMatch` rows + match-result rows are tenant data. No
direct user PII; subject erasure does not remove them.

---

## DSR procedure for THIS repo's data

### Right of access (Art. 15)

When a subject's export bundle is assembled in ledger-core, this
repo's contribution is **attribution counts only**:

1. Bank statements the subject (as ADMIN+) uploaded — count, not
   contents. The contents are tenant data.
2. Reconciliation matches the subject approved — count, not contents.
3. AI suggestions the subject accepted or rejected — count, not
   contents.

Rationale: GDPR Art. 15 grants the subject access to personal data
about THEM. The bank statements + match decisions are tenant data
about the tenant's books, not personal data about the user. The user's
attribution role is included (e.g. "Bob uploaded 47 statements between
2024-01 and 2026-05"); the contents stay with the tenant.

The assembly helper for this repo's contribution lives at
`src/lib/privacy/recon-attribution.ts` (TODO when first DSR arrives;
typed-stub PR is the forcing function).

### Right to erasure (Art. 17)

A user-erasure in ledger-core triggers handling here:

1. **User row replica:** redact `email` + `displayName` + flip
   `isActive=false`. Mirrors the ledger-core action exactly via the
   sync path.
2. **Bank statements + matches + AI suggestions:** **preserved**. They
   are tenant property; legal-retention exemption Art. 17(3)(b)
   (compliance with legal obligation — financial recordkeeping) and
   (e) (defense of legal claims). The user's id stays on the
   attribution edges so the audit trail remains intact; only the
   identifying fields on the User row are redacted.
3. **`ReconciliationMatch` rows referencing the subject as approver:**
   `approvedByUserId` stays; the row is preserved.

There is no recon-specific erasure orchestrator. The Postgres
sync replicates the redacted User row from ledger-core; that's the
entire erasure footprint on this repo.

### Right to rectification (Art. 16)

Not applicable. User/Tenant updates flow from ledger-core; recon
surfaces are tenant-curated, not subject-curated.

### Right to portability (Art. 20)

Covered by the access export attribution counts. No separate
procedure.

---

## What an auditor asks for, and where it lives

| Auditor question | Where the answer lives |
|---|---|
| "Do you have a DSR procedure?" | `ledger-core/docs/policies/data-subject-requests.md` (canonical) + this file (this-repo scope) |
| "Are reconciliation surfaces encrypted at rest?" | `src/lib/db/encrypted-fields-extension.ts` column registry — see the table above for the full column list |
| "When a subject is erased, what happens to their bank-statement uploads?" | "Right to erasure" section above — preserved as tenant data, attribution edges kept, User row redacted via ledger-core sync |
| "Show me proof an erasure-driven sync actually ran" | `audit_log` row of type `DATA_ERASURE` in ledger-core; the recon-side User row has the redacted email matching the audit metadata |

---

## Open items (tracked for the next sprint, not blocking)

1. **`src/lib/privacy/recon-attribution.ts`** — typed stub for the
   attribution-counts helper that ledger-core's export bundle calls
   into. Until then, manual SQL.
2. **Mirror to the canonical ledger-core export bundle's external
   contributions section** so an export run actually includes recon
   counts.
