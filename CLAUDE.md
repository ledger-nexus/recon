# Claude Code Instructions for recon

Auto-loaded by Claude Code on every session in this repo.

## What this project is

`recon` is the AI-assisted bank reconciliation companion to `ledger-core`. It shares a Postgres database with ledger-core, reads journal entries via Prisma, ingests bank statement CSVs, proposes matches between bank lines and JE lines, and writes adjustments back to the ledger via ledger-core's `postJournalEntry` — never bypassing the posting boundary.

The architecture canon is `docs/ARCHITECTURE.md`. Read it before changing how recon talks to ledger-core.

## The non-negotiables

1. **AI suggests; humans approve; ledger-core posts.** No code path in this repo may write to ledger-core's tables directly. Adjustment JEs cross the boundary via the HTTP bridge in `src/lib/ledger-bridge.ts`, which POSTs to ledger-core's `/api/internal/journal-entries` endpoint. That endpoint is the ONLY way recon writes to the substrate. AI-influenced entries use `source: "AI_APPROVED"`; human-only entries use `source: "MANUAL"`.

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

## What's next (v0.2-beta — SHIPPED)

- ✅ **Cross-repo HTTP bridge** to ledger-core's `postJournalEntry`. Recon POSTs to `/api/internal/journal-entries` (token-gated, mirrors the existing `/api/admin/reset` pattern). NO source-level coupling between repos — each owns its own Prisma client, the wire format is the only contract. See `docs/ledger-bridge.md`.
- ✅ **Adjustment-JE Server Action** (`src/app/actions/post-adjustment.ts`) — for UNMATCHED bank lines that need a new JE (classic case: $50 wire fee never booked). Builds a two-line balanced JE (cash + counter), POSTs via the bridge with `source: "MANUAL"`, creates an APPROVED `ReconciliationMatch` linked to the new entry, flips the bank line to `ADJUSTMENT`.
- ✅ **Inline adjustment form** on `/statements/[id]` — sits next to "Suggest matches" on UNMATCHED lines. Two inputs (counter-account code + memo), one click to post.

## What's wired (v1.0 — SHIPPED)

- ✅ **Per-line Ignore / Unignore** — `src/app/actions/ignore-line.ts`. Marks a line IGNORED for non-reconcilable cases (internal transfer, already booked, etc.) with `(ignoredAt, ignoredBy, ignoreReason)` audit columns preserved across un-ignore. Withdraws competing PROPOSED matches; updates statement counters. Reversible via `unignoreLineAction`.
- ✅ **Bulk "Suggest for all unmatched"** — `proposeAllUnmatchedAction` in `src/app/actions/propose-matches.ts`. Loops over every UNMATCHED line in a statement and runs the deterministic + AI pipeline. Returns aggregate counts (proposed / no-candidates / below-threshold / errors). Sequential by design — Anthropic rate limits matter more than wall-clock speedup for <50-line statements.
- ✅ **Statement progress summary** at the top of `/statements/[id]` — % resolved + per-status counts + a progress bar. "All resolved" badge appears when 100% of lines are MATCHED / IGNORED / ADJUSTMENT. The bulk button sits inline with the progress card.
- ✅ **Schema migration** — `bank_statement_line` adds `ignoredAt`, `ignoredBy`, `ignoreReason` columns. Applied via raw SQL through `prisma db execute` (recon's standard pattern since it shares the ledger-core DB).
- ✅ **Integration tests** — `tests/ignore-line.test.ts` covers the new actions end-to-end: status transitions, counter updates, audit-column preservation, FK cascade, idempotency.

## What's next (v1.1+ ideas)

- `AiSuggestion` audit panel UI — cache-hit rate, accept/reject rates per model, cost-per-statement (SOC 2 CC4 + cost visibility)
- Smoke-test automation against a dev DB + API key in CI
- Multi-line adjustments (currently the form only supports a two-line cash+counter JE)
- Statement-level `RECONCILED` status — once 100% resolved, a "Close statement" action that locks further changes (the current "all resolved" badge is informational only)
- Bulk-approve / bulk-ignore by description regex

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

## SOC 2 — every change must satisfy these controls

This is financial software. SOC 2 Trust Services Criteria apply. The
helper module is in `src/lib/soc2/index.ts` (mirror of ledger-core's
master copy); the `/soc2` skill auto-surfaces the framework on
auth/data/audit work. Before completing any task, verify the change
conforms to the rules below — if a rule can't be satisfied, flag it
explicitly and ask before proceeding. Run `/soc2-check` on the diff
before marking work done.

- **Multi-tenant isolation (CC6.1):** every customer-data table carries
  `tenantId`. Every query that loads a row by id ALSO constrains by
  tenantId. Use `findFirst({ where: { id, tenantId } })` then
  `assertTenantScope()` from `@/lib/soc2` — never
  `findUnique({ where: { id } })` on customer data. The 2026-05-29
  audit-pass swept this across the bank-lines route and matching
  pipelines; do not regress.
- **Audit logging (CC5/CC6/CC7):** privileged mutations emit audit
  rows. This repo POSTs to ledger-core's internal audit endpoint
  rather than writing the table directly. Do not bypass.
- **Authorization (CC6.3):** every Server Action / API route gates on
  per-tenant role via the policy module. "Signed in" is necessary but
  NEVER sufficient.
- **Input validation (CC6.8):** every request body validates via Zod
  before use. Never trust a client-supplied id without re-checking
  ownership server-side.
- **Secrets handling (CC6.7):** no hardcoded secrets. Read from
  `process.env`. Token comparisons go through `constantTimeEqual`
  from `@/lib/soc2` — never `===`. Inbound webhooks always verify
  cryptographic signatures.
- **Logging hygiene (Confidentiality TSC):** every `console.log` that
  includes user data runs the payload through `redactPii()` from
  `@/lib/soc2` first.
- **Error responses (CC7):** every error sent to a client goes
  through `sanitizeError()`. Raw `err.message + err.stack` MUST NOT
  cross the wire.
- **Field-level encryption (CC6 — Confidentiality TSC):** confidential
  columns are AES-256-GCM-encrypted at rest via the Prisma extension
  in `src/lib/db/encrypted-fields-extension.ts`. Adding a new
  confidential column = adding it to `ENCRYPTED_COLUMNS` in that file
  + writing a backfill in `scripts/encrypt-{model}-{field}.ts` +
  testing the roundtrip in `tests/encrypted-fields-extension.test.ts`.
  Use `type: "json"` mode for `Json`-typed columns. Look at any of
  the existing rollouts as a reference.

  **Currently encrypted in recon:**
    - `BankStatementLine.description`
    - `Party.displayName` (READ side — ledger-core writes)
    - `BankAccount.{displayName, bankName, accountNumberLast4}`
    - `BankStatement.{filename, rawPayload}`
    - `AiSuggestion.candidatesJson` (Json mode)

  Reads in tests that touch encrypted columns must go through the
  extended client (`import { prisma } from "@/lib/db"`). A raw
  `new PrismaClient()` returns ciphertext.

When you finish a unit of work, run `/soc2-check` on the diff. Commit
messages on security-relevant changes should cite the Common Criterion
(e.g., `(CC6 — IDOR defense)`). The full gap analysis lives in
ledger-core at `docs/SOC2_READINESS.md`; the production rollout
procedure for encryption columns lives at
`ledger-core/docs/runbooks/encryption-rollout.md`.
