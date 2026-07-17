# AGENTS.md — recon

Instructions for AI coding/review agents (Codex, etc.). This is the **reviewer's contract** for recon: what to check, and what is *intentional and must NOT be reported as a defect*. Canonical detail: [`CLAUDE.md`](CLAUDE.md), architecture [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), security [`SECURITY.md`](SECURITY.md).

## What this is

`recon` is the AI-assisted bank-reconciliation companion to `ledger-core`. It shares one Postgres database with ledger-core, reads journal entries, proposes matches between bank lines and JE lines, and writes adjustment JEs back **only** through ledger-core's HTTP boundary. It never writes ledger-core's tables directly.

## Review THESE first

- **The posting boundary.** recon must never insert into ledger-core's tables. Adjustments cross via the HTTP bridge (`src/lib/ledger-bridge.ts` → ledger-core's `/api/internal/journal-entries`). AI-influenced entries carry `source: "AI_APPROVED"`, human-only `source: "MANUAL"`. Any direct DB write to a ledger-core-owned table is a defect.
- **PII redaction is load-bearing.** All error emission goes through `src/lib/monitoring/index.ts` (`captureError`/`captureMessage`), which runs `redactPii()` first. **Never call Sentry directly, and never `console.error` a Prisma/Plaid error's `.message`** — bank-line descriptions and counterparty names embed in error strings and would leak verbatim. New sensitive column → add its field name to `src/lib/soc2/redact-pii.ts`. This is a Confidentiality-TSC leak class; flag any bypass.
- **Server Actions** taking a client id must resolve current user + tenant and scope the lookup (a signed-in user from tenant A must not act on tenant B's statements/matches).
- **Tenant scoping** on every query against a shared table.

## Intentional — do NOT report these as defects

- **The `prisma/schema.prisma` "ledger-core mirror" models are GENERATED, not duplicated by mistake.** They are a column-for-column, FK-closed copy of ledger-core's owned tables so recon's Prisma client can read them. Do NOT suggest "import the models from ledger-core," "de-duplicate this schema," or "these tables are defined twice." The subset-mirror over a shared DB is the deliberate portfolio architecture.
- **`prisma db push` is BANNED and there is no `db:push` script** — a push executes the full diff, including destructive ALTERs against shared tables the mirror doesn't own. Schema changes to recon-owned tables use the reviewed-diff protocol (`npm run db:diff` → keep only recon-owned statements → `prisma db execute`). "You should run `db push` / `migrate dev`" is wrong here; don't suggest it.
- **recon talks to ledger-core over HTTP, not an in-process import** — deliberate (independent deploys, an audited wire contract). Not an architecture smell.
- **The CSV parser throws when `Σ lines ≠ Δ balance`.** Loud failure is intentional — silent parser drift is the worst bug in this domain. Don't "soften" it to a warning.
- **`src/lib/matching/deterministic.ts` makes no model calls** by design; the AI suggester is a separate module. Don't propose merging them.

## Security lens (SOC 2)

Same portfolio baseline as ledger-core: tenant isolation, audit trail, secrets from env, authorization ≠ authentication, timing-safe token comparison, no PII in logs. The redaction shim above is the most-tested control here — real bypasses are high value.
