# recon

> AI-assisted bank reconciliation on top of the `ledger-core` substrate. AI suggests; humans approve; ledger-core posts.

Companion repo to [`ledger-core`](https://github.com/ledger-nexus/ledger-core). Reads journal entries from the shared Postgres database, ingests bank statement CSVs, proposes matches between bank lines and ledger journal lines, and posts adjustment entries back through ledger-core's `postJournalEntry` — never bypassing the posting boundary.

**The security posture is the headline.** v0.1 shipped the deterministic matcher and the CSV pipeline. v0.2 closes the loop: Claude Haiku proposes matches with prompt caching on, humans approve or reject inline, and every AI run is logged to `AiSuggestion` for audit. AI never writes to the ledger directly — adjustment-JE posting (the path into `postJournalEntry`) lands in v0.2-beta.

---

## Architecture in one sentence

`recon` queries ledger-core's tables (read-only), maintains its own (`BankStatement`, `BankStatementLine`, `ReconciliationMatch`, `AiSuggestion`), and writes back to the ledger via ledger-core's posting function with `source: "AI_APPROVED"` after explicit human review.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the relationship to ledger-core in detail.

## What's wired (v0.2)

- ✅ Prisma schema: 6 ledger-core mirrored models + 5 recon-owned models (`BankAccount`, `BankStatement`, `BankStatementLine`, `ReconciliationMatch`, `AiSuggestion`)
- ✅ Bank statement CSV parser with built-in reconciliation check (Σ lines = Δ balance, fails loud if not)
- ✅ Deterministic match scorer (amount + date proximity + description tokens; weighted 0.6 / 0.25 / 0.15) with `AUTO_PROPOSE_THRESHOLD = 0.85`
- ✅ **AI match suggester** (`src/lib/matching/ai-suggest.ts`) — Claude Haiku 4.5 via the official SDK, forced-tool-use structured output, prompt caching ON for the system prefix, hallucinated `journalLineId` filtering
- ✅ **Candidate-fetching helper** (`src/lib/matching/candidates.ts`) — pulls JE lines from ledger-core's cash account by signed-amount + ±5-day window, excludes already-approved matches
- ✅ **Server Actions** (`src/app/actions/`) — `proposeMatchesAction` (runs deterministic, escalates to AI if score < 0.85, persists everything to `AiSuggestion` for audit), `approveMatchAction`, `rejectMatchAction`
- ✅ **Interactive UI** on `/statements/[id]` — per-line "Suggest matches" button, ranked proposal cards with source badges (AI / DETERMINISTIC), inline Approve / Reject
- ✅ Seed: ties to ledger-core's Northwind seed, creates a sample BankAccount + parsed March 2026 statement
- ✅ Unit tests for parser + scorer + AI suggester (with mocked Anthropic client — no live API calls in CI)

## What lands next (v0.2-beta)

- 🚧 Server Action that posts an adjustment JE via ledger-core's `postJournalEntry` when a bank line is matched but the JE has a different amount (e.g. bank fees the ledger didn't anticipate). This is the path that closes the human-approval → ledger-write loop.
- 🚧 Per-line "Ignore" + "Mark as adjustment" actions
- 🚧 `AiSuggestion` audit panel — see what the AI proposed across all bank lines, accepted vs rejected, prompt-cache hit rate

## Quick start

```bash
# Prereq: ledger-core seeded against the same DATABASE_URL
git clone https://github.com/ledger-nexus/recon.git
cd recon
pnpm install
cp .env.example .env
# Point DATABASE_URL at the same Postgres ledger-core uses

pnpm db:push      # adds bank_account, bank_statement, etc. on top of ledger-core's tables
pnpm db:seed      # creates the sample BankAccount + parsed March 2026 statement
pnpm dev          # http://localhost:3001 — note: different port than ledger-core (3000)
pnpm test         # CSV parser + matching scorer
```

## Tech stack

Same as ledger-core: Next.js 14 (App Router), Postgres + Prisma, decimal.js for money math, Vitest for tests, Tailwind for styling. AI suggestions via `@anthropic-ai/sdk` (Claude Haiku 4.5 with prompt caching).

## Project structure

```
recon/
├── prisma/
│   ├── schema.prisma                  # ledger-core mirror + recon-owned models
│   ├── fixtures/
│   │   └── acme-bank-march-2026.csv   # sample statement
│   └── seed.ts                        # wires up sample BankAccount + statement
├── src/
│   ├── app/                           # Next.js App Router
│   │   ├── layout.tsx, page.tsx
│   │   ├── accounts/                  # bank accounts list
│   │   ├── statements/                # list + upload + detail (with v0.2 inline approve/reject)
│   │   └── actions/                   # Server Actions
│   │       ├── upload-statement.ts
│   │       ├── propose-matches.ts     # deterministic + AI pipeline
│   │       └── decide-match.ts        # approve / reject
│   ├── lib/
│   │   ├── db.ts                      # PrismaClient singleton
│   │   ├── csv/parser.ts              # bank CSV parser (pure, testable)
│   │   ├── matching/
│   │   │   ├── deterministic.ts       # match scorer
│   │   │   ├── candidates.ts          # fetch JE lines from ledger-core
│   │   │   └── ai-suggest.ts          # Claude Haiku suggester (prompt-cached)
│   │   └── utils/                     # cn(), formatMoney()
│   └── components/                    # UI primitives + nav (mirror of ledger-core)
├── tests/
│   ├── parser.test.ts                 # CSV parser
│   ├── matching.test.ts               # deterministic scorer
│   └── ai-suggest.test.ts             # AI suggester (mocked SDK)
└── docs/
    ├── ARCHITECTURE.md                # relationship to ledger-core
    └── ai-matching.md                 # v0.2 design (placeholder until AI lands)
```

## About this project

Part of **[ledger-nexus](https://github.com/ledger-nexus)** — a portfolio of accounting tools built by an accountant learning to ship software with AI:

| Repo | Role | Status |
|---|---|---|
| [`ledger-core`](https://github.com/ledger-nexus/ledger-core) | Universal accounting substrate (substrate, sub-ledgers, 9 reports, ERP mappers) | v1.0 ✅ |
| `recon` (this) | AI-assisted bank reconciliation | v0.2 in flight |
| `revenue-rec` | ASC 606 revenue recognition engine | unstarted |

MIT licensed.
