<!-- BEGIN multi-session-orchestrator amendment (v1) -->

## ⚠️ Multi-session coordination (READ FIRST)

This repo may have parallel Claude sessions — they clobber each other's writes without coordination.

1. **Read `STATUS.md`** at the repo root before editing any file. If your task overlaps an active claim, pick a different task or surface the conflict to the user.
2. **Claim your scope** before your first edit: append a `### Session <id>` block to STATUS.md under "Active claims" with scope / files-globs / branch / heartbeat (format documented in STATUS.md). Commit STATUS.md atomically.
3. **Heartbeat** every ~20 turns. Small commit.
4. **Release** at session end: move your block to "Recent completions" with an outcome line. Commit.

Never edit another session's claim, skip the read, or claim `**`.

<!-- END multi-session-orchestrator amendment -->

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

5. **All error emission goes through the monitoring shim.** `src/lib/monitoring/index.ts` is the canonical path — `captureError(err, context)` / `captureMessage(msg, level, context)`. Every emit runs `redactPii()` before the error reaches Sentry or the console fallback. **Never call Sentry directly + never console.error a Prisma/Plaid error's `.message`** — the column-value embedding pattern is real (bank-line descriptions, counterparty names from `BankStatementLine.description` would leak verbatim). The shim's `sanitizeErrorForCapture()` strips the V8 stack preamble so `.message` PII can't leak via `.stack` (14th adversarial pass closure 2026-06-05). Add new field names to `src/lib/soc2/redact-pii.ts` allowlist when new sensitive columns ship.

## SOC 2 + adversarial-pass cadence

This repo is part of the ledger-nexus portfolio's SOC 2 Type 2 readiness program. Current state (per `ledger-core/docs/SOC2_READINESS.md`): **≈80% to Type 1 audit-ready**.

**Adversarial-pass discipline:** every substantive code shipment (NS mapper sprints, AI suggester changes, monitoring code, anything cross-tenant-touching) should be followed by an adversarial-pass audit before merge. The portfolio has run **14 adversarial passes** to date; the 2026-06-05 NS bank-recon sprint (5 PRs end-to-end) was audited inline. The 14th pass found a real HIGH in newly-shipped monitoring code: V8 `Error.stack` embeds `.message` verbatim, so the original redactPii's `.message` redaction was insufficient. Closed via recon PR #24 2nd commit.

The cadence is the evidence: SOC 2 CC4 (Monitoring Activities) auditors grade "this team finds + closes their own weaknesses." A self-discovered HIGH closed in-session with tests pinning the attack scenario is the highest-confidence CC4 evidence form. **When you ship something load-bearing, run an adversarial pass before declaring done.**

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

## SOC 2 / Deficiency-log re-audit pattern (institutionalized 2026-06-06)

**Before opening an engineering PR to close a tracked deficiency in `docs/policies/control-deficiency-log.md`, re-audit whether the closure is already on main.** The deficiency log can lag architectural reality — a status flip from Open → Remediated may be a doc PR away, not engineering work.

**Re-audit playbook** (proven in ledger-core — closed the only Critical-severity Open deficiency via doc-only PRs):

1. Read the deficiency row's "Description" carefully — what's the attack/gap?
2. `git log --all --oneline -- <relevant_file_path>` — does main have a commit addressing it?
3. `git show main:<path>` — does the layered defense already exist?
4. Look for verification tests (`tests/<feature>.test.ts`)
5. If all three answer YES, the deficiency is **Remediated**. Open a doc-only PR flipping the status + amending readiness % + risk register score.

This pattern surfaces hidden Remediated state that would otherwise sit as Open in the log, creating a false picture of audit-readiness.
