# Architecture — how recon relates to ledger-core

## The split

`recon` and `ledger-core` are **two repos sharing one Postgres database**. The split is by responsibility, not by data ownership:

| | ledger-core | recon |
|---|---|---|
| Owns the schema for | `JournalEntry`, `JournalLine`, `Account`, `LegalEntity`, `Book`, sub-ledgers, dimensions | `BankAccount`, `BankStatement`, `BankStatementLine`, `ReconciliationMatch`, `AiSuggestion` |
| Writes JEs | Yes — `postJournalEntry` is its export | **No** — recon never writes the GL directly |
| Runs `prisma db push` | Yes — canonical migration source | Only for its own tables (additive only) |
| Has AI at runtime | **No** — deterministic | **Yes** — match suggestions via Claude API (v0.2+) |
| Has a UI | Yes — `/journal-entries`, reports | Yes — `/statements`, match approval (v0.2+) |
| Production posture | "Belt-and-suspenders correctness" | "Suggest fast, let humans confirm" |

## Why one database, not separate

The universal-schema spec (`docs/universal-schema.md` in ledger-core) says explicitly:

> Postgres schema dependency is honestly cleaner than npm-package dependency for this domain.

A shared DB means recon can query JournalEntry/JournalLine with Prisma's normal client — no cross-service API calls, no eventual-consistency lag, no schema-version skew between an API consumer and the producer. The cost is operational coupling: deploying a schema change in ledger-core requires recon's schema mirror to be kept in sync.

For a portfolio project this is a fine trade-off. In production at scale you'd add a `ledger-core-types` npm package (or a proto file) to lock the contract.

## The schema mirror

`recon/prisma/schema.prisma` declares six models that already exist in ledger-core: `LegalEntity`, `Book`, `Account`, `Party`, `JournalEntry`, `JournalLine`. **These are read-only contracts** — recon uses them to query but does NOT include the full ledger-core surface (no Sub-ledgers, no dimension engine, no posting rules).

Running `prisma db push` from recon's directory will:

- See the mirrored tables already exist (created by ledger-core's push) and leave them alone
- See recon's new tables don't exist and create them

If ledger-core's schema changes (a new column on `Account`, say), the recon mirror gets out of sync. Until you re-sync, recon's Prisma client may have fewer fields than the actual table. Runtime queries still work (Prisma ignores unknown DB columns), but you lose type-checking on the new field.

**Mitigation:** treat this file like a contract. When you make a schema change in ledger-core, update recon's mirror in the same PR or open an issue.

## The write path — AI never posts directly

The flow when recon needs to record an adjustment (e.g., the bank statement shows a $50 wire fee that wasn't in the ledger):

```
Bank line:                          Recon UI:                    ledger-core:
  $50 WIRE FEE                  ┌──────────────────────┐
  ↓                             │ Match suggested for: │
  AI suggests:                  │ — (no match found)   │
  "no match — post adjustment   │                      │
   Dr 7300 G&A, Cr 1000 Cash"   │ [Post adjustment]   │
                                │ [Ignore line]        │
                                └──────────────────────┘
                                          ↓
                                    Human clicks
                                    "Post adjustment"
                                          ↓
                            recon calls postJournalEntry({
                              entityCode, bookCode,
                              source: "AI_APPROVED",
                              lines: [...],
                              sourceSystem: "recon",
                              sourceRecordId: bankLineId,
                            })
                                          ↓
                            ledger-core enforces Dr=Cr,
                            atomicity, period-close,
                            book-scope. Returns entryNumber.
                                          ↓
                            recon stores entryNumber on the
                            ReconciliationMatch row.
```

The CLAUDE.md non-negotiables enforce this:

> AI suggests; humans approve; the system posts. AI is not trusted to post entries directly. Any AI-influenced entry flows through `postJournalEntry` with `source: "AI_APPROVED"` after human confirmation.

Recon is structurally incapable of bypassing this because (a) it doesn't have direct table-write access — Prisma's client respects the schema constraints, and (b) the Server Action that posts adjustments imports `postJournalEntry` from ledger-core's API.

## Why ledger-core ports 3000 and recon 3001

Both apps are Next.js. They can run side-by-side in development. Vercel deployments are independent (different projects, different URLs).

## What v0.1 doesn't do

- Doesn't yet call Claude API — only deterministic matching
- Doesn't yet post adjustment JEs back to ledger-core (the Server Action exists in shape but not wired)
- Doesn't yet have an interactive approve/reject UI — statement detail is read-only
- Doesn't yet have OFX or QFX parsers — just generic CSV

All of these land in v0.2.
