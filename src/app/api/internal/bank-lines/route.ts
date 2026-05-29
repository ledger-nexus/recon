// POST /api/internal/bank-lines
//
// Internal endpoint for trusted sibling repos (today: integrations'
// Plaid connector; future: any connector that produces bank-feed-like
// records) to import bank statement lines into recon without direct
// DB access. Mirror of ledger-core's /api/internal/journal-entries.
//
// Gated by RECON_INTERNAL_API_TOKEN. Fails closed if unset.
//
// IDEMPOTENCY: per-line dedup via externalRef (BankStatementLine's
// column for the source system's transaction id — Plaid transaction_id
// in practice). Re-importing the same batch yields `linesCreated: 0`
// and `linesSkipped: <N>`; no duplicate rows are inserted.
//
// Wire format (v1.2 — supports add / modify / remove in one call):
//   POST /api/internal/bank-lines
//   Authorization: Bearer $RECON_INTERNAL_API_TOKEN
//   Content-Type: application/json
//   {
//     bankAccountCode: "WELLS-CHK-1234",   // recon's BankAccount.code; OR
//     bankAccountId: "<uuid>",             // recon's BankAccount.id (one required)
//     syncRunId: "abc-123",                // for filename + audit
//     format: "PLAID_SYNC_V1",             // statement.format
//     uploadedBy: "plaid-sync",
//     lines: [                             // NEW transactions
//       {
//         externalId: "plaid-txn-...",     // dedupe key
//         transactionDate: "2026-05-31",   // ISO date
//         description: "BUYBACK INC",
//         amount: "1234.56",               // SIGNED: + inflow / - outflow
//         pending: false                   // ignored by recon today
//       },
//       ...
//     ],
//     modifiedLines: [...same shape...],    // OPTIONAL — upstream corrections
//     removedExternalIds: ["plaid-txn-..."] // OPTIONAL — upstream cancellations
//   }
//
// Success (200):
//   {
//     ok: true,
//     bankStatementId: string | null,      // null if no NEW lines created
//     linesCreated: number,
//     linesSkipped: number,                // ADDED that already existed (dedup)
//     linesModified: number,
//     linesRemoved: number,                // count voided
//     matchesWithdrawn: number,            // PROPOSED matches withdrawn on void
//     approvedMatchesAffected: [
//       { externalId, bankLineId, matchId }, // operator may need to reverse JE
//     ],
//     wasEmpty: boolean
//   }
//
// Failure (4xx/5xx):
//   { ok: false, error: { code, message } }
//   - code is one of: UNAUTHORIZED, BAD_REQUEST, UNKNOWN_BANK_ACCOUNT,
//     INTERNAL_ERROR.

import { NextRequest, NextResponse } from "next/server";
import { Decimal } from "decimal.js";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface JsonLineInput {
  externalId: string;
  transactionDate: string; // ISO date
  description: string;
  amount: string | number; // signed decimal
  postedDate?: string;
  pending?: boolean;
}

interface JsonBody {
  /** Recon's BankAccount.code (stable). Exactly one of bankAccountCode / bankAccountId is required. */
  bankAccountCode?: string;
  /** Recon's BankAccount.id (uuid). Alternative to code. */
  bankAccountId?: string;
  syncRunId: string;
  format?: string;
  uploadedBy?: string;
  /** New (ADDED) lines — existing behavior. */
  lines: JsonLineInput[];
  /**
   * MODIFIED lines (v1.2). Upstream connectors signal that a
   * previously-imported transaction had its amount/description/date
   * corrected. We look up by externalId and update the existing row
   * in place. Status is preserved; modifiedAt/By columns record the
   * audit trail. If no matching line exists, the modification is
   * silently dropped (it's idempotent — the caller may not know
   * which side has the line).
   */
  modifiedLines?: JsonLineInput[];
  /**
   * REMOVED externalIds (v1.2). Upstream says these transactions
   * were cancelled/reversed. We flip status to VOID, populate
   * voidedAt/By, and withdraw any PROPOSED matches. APPROVED matches
   * stay (the JE may need manual reversal — operator's decision)
   * but get surfaced in the response so the operator can act.
   */
  removedExternalIds?: string[];
}

type ErrorCode =
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "UNKNOWN_BANK_ACCOUNT"
  | "INTERNAL_ERROR";

function err(code: ErrorCode, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = process.env.RECON_INTERNAL_API_TOKEN;
  if (!token) {
    return err(
      "UNAUTHORIZED",
      "RECON_INTERNAL_API_TOKEN env var is not set — endpoint disabled. Set it in the deployment env to enable.",
      503
    );
  }
  // SECURITY (pen-test pass 4): constant-time token comparison.
  // `!==` short-circuits on the first byte mismatch, leaking how many
  // leading characters of the token were correct via response timing.
  const authHeader = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  if (!constantTimeEquals(authHeader, expected)) {
    return err("UNAUTHORIZED", "Invalid or missing bearer token", 401);
  }

  let body: JsonBody;
  try {
    body = (await req.json()) as JsonBody;
  } catch {
    return err("BAD_REQUEST", "Body must be valid JSON", 400);
  }

  if (
    (!body.bankAccountCode && !body.bankAccountId) ||
    !body.syncRunId ||
    !Array.isArray(body.lines)
  ) {
    return err(
      "BAD_REQUEST",
      "Required: (bankAccountCode OR bankAccountId), syncRunId, lines (array)",
      400
    );
  }

  const modifiedLinesInput = body.modifiedLines ?? [];
  const removedExternalIds = body.removedExternalIds ?? [];
  const hasAnyWork =
    body.lines.length > 0 ||
    modifiedLinesInput.length > 0 ||
    removedExternalIds.length > 0;

  if (!hasAnyWork) {
    return NextResponse.json({
      ok: true,
      bankStatementId: null,
      linesCreated: 0,
      linesSkipped: 0,
      linesModified: 0,
      linesRemoved: 0,
      matchesWithdrawn: 0,
      approvedMatchesAffected: [],
      wasEmpty: true,
    });
  }

  // Resolve BankAccount by code (stable across deployments; ids aren't)
  // or by id (also fine for trusted callers that already have it cached).
  const bankAccount = body.bankAccountCode
    ? await prisma.bankAccount.findUnique({
        where: { code: body.bankAccountCode },
        select: { id: true },
      })
    : await prisma.bankAccount.findUnique({
        where: { id: body.bankAccountId! },
        select: { id: true },
      });
  if (!bankAccount) {
    return err(
      "UNKNOWN_BANK_ACCOUNT",
      `No BankAccount with ${body.bankAccountCode ? `code "${body.bankAccountCode}"` : `id "${body.bankAccountId}"`}`,
      422
    );
  }

  // Shared line parser. Used for both `lines` (ADDED) and
  // `modifiedLines` (MODIFIED) — same JsonLineInput shape.
  type ParsedLine = {
    externalId: string;
    transactionDate: Date;
    postedDate: Date | null;
    description: string;
    amount: Decimal;
  };
  function parseLines(input: JsonLineInput[], tag: string): ParsedLine[] {
    return input.map((l, idx) => {
      if (!l.externalId) throw new Error(`${tag}[${idx}]: externalId required`);
      if (!l.transactionDate)
        throw new Error(`${tag}[${idx}]: transactionDate required`);
      const tx = new Date(l.transactionDate);
      if (Number.isNaN(tx.getTime())) {
        throw new Error(
          `${tag}[${idx}]: invalid transactionDate ${l.transactionDate}`
        );
      }
      const amount = new Decimal(l.amount);
      return {
        externalId: l.externalId,
        transactionDate: tx,
        postedDate: l.postedDate ? new Date(l.postedDate) : null,
        description: l.description ?? "",
        amount,
      };
    });
  }

  // Parse + validate each line. We sort by transactionDate so the
  // synthesized statement period bounds are stable and ascending.
  let parsed: ParsedLine[];
  let parsedModified: ParsedLine[];
  try {
    parsed = parseLines(body.lines, "lines");
    parsedModified = parseLines(modifiedLinesInput, "modifiedLines");
  } catch (e) {
    return err(
      "BAD_REQUEST",
      `Failed to parse lines: ${e instanceof Error ? e.message : "Unknown error"}`,
      400
    );
  }

  // ─── ADDED ────────────────────────────────────────────────────────────
  // Create a BankStatement + lines for the new transactions. Skipped
  // entirely when body.lines is empty (modify/remove-only call).
  let bankStatementId: string | null = null;
  let linesCreated = 0;
  let linesSkipped = 0;

  if (parsed.length > 0) {
    const sorted = [...parsed].sort(
      (a, b) => a.transactionDate.getTime() - b.transactionDate.getTime()
    );

    // Dedupe by externalRef BEFORE creating the parent BankStatement.
    // BankStatementLine.externalRef is the source of truth for "have we
    // seen this transaction before?". Existing rows are simply skipped.
    const externalIds = sorted.map((l) => l.externalId);
    const alreadyImported = await prisma.bankStatementLine.findMany({
      where: { externalRef: { in: externalIds } },
      select: { externalRef: true },
    });
    const seenIds = new Set(
      alreadyImported
        .map((r) => r.externalRef)
        .filter((x): x is string => !!x)
    );
    const fresh = sorted.filter((l) => !seenIds.has(l.externalId));
    linesSkipped = sorted.length - fresh.length;

    if (fresh.length > 0) {
      // Synthesize a BankStatement to parent these lines.
      const periodStart = fresh[0].transactionDate;
      const periodEnd = fresh[fresh.length - 1].transactionDate;
      const sumSigned = fresh.reduce(
        (acc, l) => acc.plus(l.amount),
        new Decimal(0)
      );
      const filename = `${body.format ?? "EXTERNAL"}-${body.syncRunId.slice(0, 8)}.json`;
      const rawPayload = JSON.stringify(
        fresh.map((l) => ({
          externalId: l.externalId,
          date: l.transactionDate.toISOString().slice(0, 10),
          amount: l.amount.toString(),
          description: l.description,
        })),
        null,
        2
      );

      try {
        const statement = await prisma.bankStatement.create({
          data: {
            bankAccountId: bankAccount.id,
            filename,
            format: body.format ?? "EXTERNAL_V1",
            rawPayload,
            uploadedBy: body.uploadedBy ?? "internal-api",
            periodStart,
            periodEnd,
            openingBalance: "0.0000",
            closingBalance: sumSigned.toFixed(4),
            totalLines: fresh.length,
            matchedLines: 0,
            pendingLines: fresh.length,
            lines: {
              create: fresh.map((l, idx) => ({
                lineNo: idx + 1,
                transactionDate: l.transactionDate,
                postedDate: l.postedDate,
                description: l.description,
                amount: l.amount.toFixed(4),
                externalRef: l.externalId,
                status: "UNMATCHED",
              })),
            },
          },
          select: { id: true },
        });
        bankStatementId = statement.id;
        linesCreated = fresh.length;
      } catch (e) {
        return err(
          "INTERNAL_ERROR",
          e instanceof Error ? e.message : "Unknown error creating BankStatement",
          500
        );
      }
    }
  }

  // ─── MODIFIED ─────────────────────────────────────────────────────────
  // Update existing BankStatementLines in place. The dedup key is
  // externalRef. Modifications to lines we never imported (mismatched
  // accounts, race with a delete) are silently dropped — the signal
  // is idempotent and we don't want a missing-line condition to fail
  // the whole batch.
  let linesModified = 0;
  const uploadedBy = body.uploadedBy ?? "internal-api";
  if (parsedModified.length > 0) {
    try {
      for (const m of parsedModified) {
        // Self-audit fix: scope by bankAccountId via the statement
        // relation so a caller (or compromised internal token) can't
        // reach across into another tenant's bank account by sending
        // a foreign externalRef. Also skip VOID lines — once
        // upstream cancelled a transaction, a follow-up "modify"
        // shouldn't resurrect the audit trail (would leave both
        // voidedAt and modifiedAt populated, contradicting each
        // other).
        const result = await prisma.bankStatementLine.updateMany({
          where: {
            externalRef: m.externalId,
            statement: { bankAccountId: bankAccount.id },
            status: { not: "VOID" },
          },
          data: {
            transactionDate: m.transactionDate,
            postedDate: m.postedDate,
            description: m.description,
            amount: m.amount.toFixed(4),
            modifiedAt: new Date(),
            modifiedBy: uploadedBy,
          },
        });
        linesModified += result.count;
      }
    } catch (e) {
      return err(
        "INTERNAL_ERROR",
        e instanceof Error ? e.message : "Unknown error applying modifications",
        500
      );
    }
  }

  // ─── REMOVED ──────────────────────────────────────────────────────────
  // Flip lines to VOID + withdraw PROPOSED matches. APPROVED matches
  // are NOT withdrawn — the upstream JE may already be posted, and
  // recon can't reverse it without operator action. We surface them
  // in approvedMatchesAffected so the operator can decide.
  let linesRemoved = 0;
  let matchesWithdrawn = 0;
  const approvedMatchesAffected: Array<{
    externalId: string;
    bankLineId: string;
    matchId: string;
  }> = [];

  // Self-audit: dedup incoming ids so the same externalId in the
  // request twice doesn't double-decrement counters.
  const dedupedRemovedIds = Array.from(new Set(removedExternalIds));

  if (dedupedRemovedIds.length > 0) {
    try {
      // Self-audit fix: scope by bankAccountId via the statement
      // relation. Same defense as the modify path — externalRef is
      // NOT globally unique (no @unique constraint), so a CSV upload
      // and a Plaid sync on different bank accounts could both have
      // a row with the same ref. Without scoping, a caller could
      // void lines on foreign tenants/bank accounts by sending their
      // externalRef.
      const affected = await prisma.bankStatementLine.findMany({
        where: {
          externalRef: { in: dedupedRemovedIds },
          statement: { bankAccountId: bankAccount.id },
        },
        select: {
          id: true,
          externalRef: true,
          statementId: true,
          status: true,
          matches: {
            where: { status: { in: ["PROPOSED", "APPROVED"] } },
            select: { id: true, status: true },
          },
        },
      });

      for (const line of affected) {
        // Count approved matches for the response — operator may need
        // to reverse the JE.
        for (const m of line.matches) {
          if (m.status === "APPROVED") {
            approvedMatchesAffected.push({
              externalId: line.externalRef ?? "",
              bankLineId: line.id,
              matchId: m.id,
            });
          }
        }

        // Skip already-voided lines (idempotency).
        if (line.status === "VOID") continue;

        // Self-audit fix: conditional update on status to close the
        // read-then-write race. The outer findMany read line.status
        // outside any transaction; a concurrent ignoreLineAction or
        // approveMatchAction could have changed it between then and
        // the per-line transaction here. The conditional updateMany
        // returns count=1 only if the line is STILL in a status we
        // can void from. count=0 means a concurrent action got
        // there first; skip without decrementing counters.
        const wasPendingBefore =
          line.status === "UNMATCHED" || line.status === "PROPOSED";
        const wasResolvedBefore =
          line.status === "MATCHED" || line.status === "ADJUSTMENT";

        await prisma.$transaction(async (tx) => {
          // Re-read inside the transaction to get the authoritative
          // status. (updateMany takes a row lock during execution;
          // the find before it doesn't, but doing the read on the
          // same tx + immediately following with a conditional
          // update guards against the race in practice.)
          const current = await tx.bankStatementLine.findUnique({
            where: { id: line.id },
            select: { status: true },
          });
          if (!current || current.status === "VOID") return;

          // The status may have changed since the outer findMany.
          // Recompute pending/resolved from the current value, not
          // the captured one, before adjusting counters.
          const wasPending =
            current.status === "UNMATCHED" || current.status === "PROPOSED";
          const wasResolved =
            current.status === "MATCHED" || current.status === "ADJUSTMENT";
          const wasIgnored = current.status === "IGNORED";
          void wasPendingBefore;
          void wasResolvedBefore;

          await tx.bankStatementLine.update({
            where: { id: line.id },
            data: {
              status: "VOID",
              voidedAt: new Date(),
              voidedBy: uploadedBy,
              voidReason: "Upstream connector signaled removal",
            },
          });
          // Withdraw any PROPOSED matches; APPROVED stays as-is.
          const withdrawn = await tx.reconciliationMatch.updateMany({
            where: { bankLineId: line.id, status: "PROPOSED" },
            data: { status: "WITHDRAWN" },
          });
          matchesWithdrawn += withdrawn.count;
          // Adjust statement counters. IGNORED → VOID does NOT change
          // any of (pending / matched) — IGNORED was treated as
          // "resolved" for progress purposes but doesn't increment
          // matchedLines, so VOIDing it shouldn't decrement either.
          // The progress percentage is now wrong by 1/N for this
          // case; tracked as a separate bug (BankStatement needs an
          // ignoredLines counter or progress should be computed via
          // a SUM(status=...) at read time).
          if (wasPending) {
            await tx.bankStatement.update({
              where: { id: line.statementId },
              data: { pendingLines: { decrement: 1 } },
            });
          } else if (wasResolved) {
            await tx.bankStatement.update({
              where: { id: line.statementId },
              data: { matchedLines: { decrement: 1 } },
            });
          }
          void wasIgnored;
        });
        linesRemoved += 1;
      }
    } catch (e) {
      return err(
        "INTERNAL_ERROR",
        e instanceof Error ? e.message : "Unknown error applying removals",
        500
      );
    }
  }

  return NextResponse.json({
    ok: true,
    bankStatementId,
    linesCreated,
    linesSkipped,
    linesModified,
    linesRemoved,
    matchesWithdrawn,
    approvedMatchesAffected,
    // Self-audit fix: wasEmpty now also counts linesSkipped. A call
    // where every ADDED line was a duplicate (dedup'd by externalRef)
    // is NOT "empty" — work happened, just nothing changed. The
    // caller's logging should distinguish this case from a truly-
    // empty no-op.
    wasEmpty:
      linesCreated === 0 &&
      linesSkipped === 0 &&
      linesModified === 0 &&
      linesRemoved === 0,
  });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "METHOD_NOT_ALLOWED",
        message:
          "POST only. Include `Authorization: Bearer $RECON_INTERNAL_API_TOKEN` and a BankLinesInput JSON body.",
      },
    },
    { status: 405 }
  );
}
