# recon

> AI-assisted bank reconciliation on top of the `ledger-core` substrate. AI suggests; humans approve; ledger-core posts.

Companion repo to [`ledger-core`](https://github.com/ledger-nexus/ledger-core). Reads journal entries from the shared Postgres database, ingests bank statement CSVs, proposes matches between bank lines and ledger journal lines, and posts adjustment entries back through ledger-core's `postJournalEntry` — never bypassing the posting boundary.

**The security posture is the headline.** v0.1 ships the deterministic matcher and the CSV pipeline. v0.2 adds the Claude API integration for AI suggestions with prompt caching. Every AI suggestion goes through human approval before any ledger write happens. AI never posts directly.

---

## Architecture in one sentence

`recon` queries ledger-core's tables (read-only), maintains its own (`BankStatement`, `BankStatementLine`, `ReconciliationMatch`, `AiSuggestion`), and writes back to the ledger via ledger-core's posting function with `source: "AI_APPROVED"` after explicit human review.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the relationship to ledger-core in detail.

## What's wired (v0.1)

- ✅ Prisma schema: 6 ledger-core mirrored models + 5 recon-owned models (`BankAccount`, `BankStatement`, `BankStatementLine`, `ReconciliationMatch`, `AiSuggestion`)
- ✅ Bank statement CSV parser with built-in reconciliation check (Σ lines = Δ balance, fails loud if not)
- ✅ Deterministic match scorer (amount + date proximity + description tokens; weighted 0.6 / 0.25 / 0.15) with `AUTO_PROPOSE_THRESHOLD = 0.85`
- ✅ Next.js App Router UI: dashboard, statements list, upload form (Server Action that parses + persists in one transaction), statement detail with parsed lines + reconciliation badge
- ✅ Seed: ties to ledger-core's Northwind seed, creates a sample BankAccount + parsed March 2026 statement
- ✅ Unit tests for parser + scorer (no DB needed)

## What lands next (v0.2)

- 🚧 Anthropic API integration for AI-proposed matches (uses the `claude-api` skill's prompt-caching pattern; `claude-haiku-4-5` for fast/cheap matching)
- 🚧 Interactive approve/reject UI on the statement detail page
- 🚧 Server Action that posts an adjustment JE via ledger-core's `postJournalEntry` when a bank line is matched but the JE has a different amount (e.g. bank fees the ledger didn't anticipate)
- 🚧 Per-line "Ignore" + "Adjust" actions
- 🚧 `AiSuggestion` audit panel — see what the AI proposed, accepted, rejected

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

Same as ledger-core: Next.js 14 (App Router), Postgres + Prisma, decimal.js for money math, Vitest for tests, Tailwind for styling. Anthropic SDK lands in v0.2 for AI suggestions.

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
│   │   ├── statements/                # list + upload + detail
│   │   └── actions/upload-statement.ts # Server Action
│   ├── lib/
│   │   ├── db.ts                      # PrismaClient singleton
│   │   ├── csv/parser.ts              # bank CSV parser (pure, testable)
│   │   ├── matching/deterministic.ts  # match scorer
│   │   └── utils/                     # cn(), formatMoney()
│   └── components/                    # UI primitives + nav (mirror of ledger-core)
├── tests/
│   ├── parser.test.ts                 # CSV parser
│   └── matching.test.ts               # deterministic scorer
└── docs/
    ├── ARCHITECTURE.md                # relationship to ledger-core
    └── ai-matching.md                 # v0.2 design (placeholder until AI lands)
```

## About this project

Part of **[ledger-nexus](https://github.com/ledger-nexus)** — a portfolio of accounting tools built by an accountant learning to ship software with AI:

| Repo | Role | Status |
|---|---|---|
| [`ledger-core`](https://github.com/ledger-nexus/ledger-core) | Universal accounting substrate (substrate, sub-ledgers, 9 reports, ERP mappers) | v1.0 ✅ |
| `recon` (this) | AI-assisted bank reconciliation | v0.1 in flight |
| `revenue-rec` | ASC 606 revenue recognition engine | unstarted |

MIT licensed.
