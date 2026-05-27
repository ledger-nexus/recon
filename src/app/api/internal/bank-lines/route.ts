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
// Wire format:
//   POST /api/internal/bank-lines
//   Authorization: Bearer $RECON_INTERNAL_API_TOKEN
//   Content-Type: application/json
//   {
//     bankAccountCode: "WELLS-CHK-1234",   // recon's BankAccount.code; OR
//     bankAccountId: "<uuid>",             // recon's BankAccount.id (one of the two is required)
//     syncRunId: "abc-123",                // for filename + audit
//     format: "PLAID_SYNC_V1",             // statement.format
//     uploadedBy: "plaid-sync",
//     lines: [
//       {
//         externalId: "plaid-txn-...",     // dedupe key
//         transactionDate: "2026-05-31",   // ISO date
//         description: "BUYBACK INC",
//         amount: "1234.56",               // SIGNED: + inflow / - outflow
//         pending: false                   // ignored by recon today
//       },
//       ...
//     ]
//   }
//
// Success (200):
//   {
//     ok: true,
//     bankStatementId: string | null,      // null if all lines were dups
//     linesCreated: number,
//     linesSkipped: number,
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
  lines: JsonLineInput[];
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

  if (body.lines.length === 0) {
    return NextResponse.json({
      ok: true,
      bankStatementId: null,
      linesCreated: 0,
      linesSkipped: 0,
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

  // Parse + validate each line. We sort by transactionDate so the
  // synthesized statement period bounds are stable and ascending.
  let parsed: Array<{
    externalId: string;
    transactionDate: Date;
    postedDate: Date | null;
    description: string;
    amount: Decimal;
  }>;
  try {
    parsed = body.lines.map((l, idx) => {
      if (!l.externalId) throw new Error(`line ${idx}: externalId required`);
      if (!l.transactionDate) throw new Error(`line ${idx}: transactionDate required`);
      const tx = new Date(l.transactionDate);
      if (Number.isNaN(tx.getTime())) {
        throw new Error(`line ${idx}: invalid transactionDate ${l.transactionDate}`);
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
  } catch (e) {
    return err(
      "BAD_REQUEST",
      `Failed to parse lines: ${e instanceof Error ? e.message : "Unknown error"}`,
      400
    );
  }

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
  const linesSkipped = sorted.length - fresh.length;

  if (fresh.length === 0) {
    return NextResponse.json({
      ok: true,
      bankStatementId: null,
      linesCreated: 0,
      linesSkipped,
      wasEmpty: false,
    });
  }

  // Synthesize a BankStatement to parent these lines. v0.1 starts the
  // opening at 0 and sets closing = signed-sum; a future revision can
  // accept opening/closing balances from the connector when known.
  const periodStart = fresh[0].transactionDate;
  const periodEnd = fresh[fresh.length - 1].transactionDate;
  const sumSigned = fresh.reduce((acc, l) => acc.plus(l.amount), new Decimal(0));
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

    return NextResponse.json({
      ok: true,
      bankStatementId: statement.id,
      linesCreated: fresh.length,
      linesSkipped,
      wasEmpty: false,
    });
  } catch (e) {
    return err(
      "INTERNAL_ERROR",
      e instanceof Error ? e.message : "Unknown error creating BankStatement",
      500
    );
  }
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
