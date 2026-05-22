# Claude Code Instructions for recon

Auto-loaded by Claude Code on every session in this repo.

## What this project is

`recon` is the AI-assisted bank reconciliation companion to `ledger-core`. It shares a Postgres database with ledger-core, reads journal entries via Prisma, ingests bank statement CSVs, proposes matches between bank lines and JE lines, and writes adjustments back to the ledger via ledger-core's `postJournalEntry` — never bypassing the posting boundary.

The architecture canon is `docs/ARCHITECTURE.md`. Read it before changing how recon talks to ledger-core.

## The non-negotiables

1. **AI suggests; humans approve; ledger-core posts.** No code path in this repo may write to ledger-core's tables directly. Adjustment JEs go through `postJournalEntry` imported from ledger-core's module, with `source: "AI_APPROVED"` for AI-assisted entries and `source: "MANUAL"` for human-only ones.

2. **Recon's schema mirror is a contract.** The six ledger-core models in `prisma/schema.prisma` (LegalEntity, Book, Account, Party, JournalEntry, JournalLine) must match ledger-core's definitions column-for-column. If you change them here, you've broken the contract.

3. **Parser failures must be loud.** The CSV parser asserts `Σ lines = Δ balance` and throws if it doesn't reconcile. Silent parser drift is the worst kind of bug in this domain.

4. **Deterministic match scoring stays deterministic.** No model calls inside `src/lib/matching/deterministic.ts`. The AI suggester lives in `src/lib/matching/ai-suggest.ts` (v0.2+) and is invoked separately.

## What's wired (v0.2)

- Bank statement CSV parser with reconciliation check
- Deterministic match scoring (amount + date + description tokens)
- **AI match suggester** — `src/lib/matching/ai-suggest.ts`. Claude Haiku 4.5 via the official `@anthropic-ai/sdk`, forced-tool-use for structured output, prompt caching on the system prefix, hallucinated-ID filter.
- **Candidate-fetching helper** — `src/lib/matching/candidates.ts`. Pulls JE lines from ledger-core's cash account by signed-amount + ±5-day window, excludes already-APPROVED matches.
- **Match Server Actions** — `src/app/actions/propose-matches.ts` (deterministic + AI pipeline, persists `AiSuggestion` for audit), `src/app/actions/decide-match.ts` (approve / reject, sibling withdrawal, statement counter updates).
- **Interactive UI** — `/statements/[id]` shows "Suggest matches" per UNMATCHED line, ranked proposal cards with source badges (AI / DETERMINISTIC) and confidence percentages, inline Approve / Reject buttons.
- Next.js UI: dashboard, statements list, upload form, statement detail (interactive)
- Sample fixture: Acme Bank March 2026 (9 lines, ties to Northwind seed)
- Unit tests for parser + scorer + AI suggester (mocked SDK)

See [`docs/ai-matching.md`](docs/ai-matching.md) for the full pipeline + prompt-caching + audit design.

## What's next (v0.2-beta)

- Server Action that posts adjustment JEs via ledger-core's `postJournalEntry` — for the case where the bank line is matched but the JE amount is off by a small bank fee or rounding. THIS is the path that crosses into ledger-core; treat the import boundary carefully.
- Per-line "Ignore" + "Mark as adjustment" actions
- `AiSuggestion` audit panel UI — cache-hit rate, accept/reject rates per model, cost-per-statement

## Stack

- Next.js 14 (App Router), runs on port 3001 (ledger-core uses 3000)
- Postgres + Prisma (shared with ledger-core)
- decimal.js for money math
- Vitest for tests (no DB needed for v0.1 unit tests)
- Tailwind + inlined UI primitives (no shadcn CLI dep — same convention as ledger-core)
- Anthropic SDK lands in v0.2

## Rules for working in this codebase

### Money math
Always use `Decimal` from `decimal.js`. Bank amounts are signed (positive = deposit, negative = withdrawal). JE lines come from ledger-core with separate `debit` and `credit` columns; convert to signed via `debit - credit` when comparing.

### Database
- Import `prisma` from `@/lib/db` (the singleton). Never `new PrismaClient()` in a page or component.
- Recon's `prisma db push` only touches recon-owned tables. If you add a new model, it must NOT shadow an existing ledger-core table.
- Querying ledger-core's tables is fine; writing to them via Prisma is forbidden (the schema mirror gives you read-only contracts, but Prisma doesn't enforce that — discipline does).

### AI integration (v0.2+)
- Use the `claude-api` skill when adding AI features.
- Default model: `claude-haiku-4-5` for match suggestions (fast + cheap; matching is a structured-output task, not deep reasoning). Do NOT switch to Opus just because the skill suggests it as default — this is an explicit project choice.
- Prompt caching ON via `cache_control: { type: "ephemeral" }` on the stable system-prompt prefix. The volatile per-call payload goes in the user message.
- **Structured output**: this repo is on `@anthropic-ai/sdk` 0.65, which does NOT expose `messages.parse` / `output_config` / `zodOutputFormat`. Use the **forced tool-use pattern** instead — declare a single tool with a JSON Schema (derived from Zod via `zod-to-json-schema`), set `tool_choice: { type: "tool", name }`, extract the `tool_use` block, validate via `schema.parse()`. When the SDK catches up, migrate.
- Treat edits to the cached system prompt like a schema migration — any byte change invalidates the cache for every downstream call.
- Store every AI suggestion in `AiSuggestion` for audit, even if the human rejects it OR if the model returns an empty candidates array.
- The AI never sees data outside the current entity/book/period scope.
- The AI never writes to the ledger. Adjustment JEs go through `postJournalEntry` AFTER a human click.

### UI work
- Same conventions as ledger-core: App Router, Server Components by default, Server Actions for forms, inline UI primitives.
- The dashboard prioritizes "what needs my attention" — unmatched lines, pending matches — not vanity metrics.

## How to start a session

1. Read this file.
2. Read `docs/ARCHITECTURE.md` (the relationship to ledger-core).
3. Confirm: does this work belong in recon (suggesting / matching) or ledger-core (posting / reporting)?
