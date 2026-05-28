// Statement detail page. Shows every parsed bank line, its current match
// status, and (in v0.2) interactive controls to:
//   - request match suggestions (deterministic + AI Haiku)
//   - approve / reject proposed matches inline
//
// The page is a Server Component. The per-row buttons live in a Client
// Component (line-actions.tsx) that calls Server Actions directly.

import Link from "next/link";
import { Decimal } from "decimal.js";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatMoney, moneyClass } from "@/lib/utils/format";
import { LineActions, type ProposalView } from "./line-actions";
import { StatementBulkActions } from "./bulk-actions";
import { ReconcileButton, ReopenButton } from "./lock-actions";
import { canViewAdminPages } from "@/lib/auth/policy";
import { getCurrentTenant } from "@/lib/auth/session";

export default async function StatementDetailPage({
  params,
}: {
  params: { id: string };
}) {
  // SECURITY (pen-test pass 4 follow-up): tenant-scope the read.
  // Without this, a signed-in user could navigate to /statements/[any-id]
  // and read every bank line on another tenant's statement — including
  // descriptions (merchant names, transfer memos) and amounts. The page
  // also embeds the full rawPayload via the bank statement record.
  const tenant = await getCurrentTenant();
  if (!tenant) notFound();
  const statement = await prisma.bankStatement.findFirst({
    where: { id: params.id, bankAccount: { entity: { tenantId: tenant.id } } },
    include: {
      bankAccount: { select: { displayName: true, code: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          matches: {
            where: { status: { in: ["PROPOSED", "APPROVED"] } },
            orderBy: [{ status: "asc" }, { confidence: "desc" }],
            include: {
              journalLine: {
                select: {
                  id: true,
                  debit: true,
                  credit: true,
                  description: true,
                  entry: {
                    select: { entryNumber: true, documentDate: true, memo: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!statement) notFound();

  const sumOfLines = statement.lines.reduce(
    (acc, l) => acc.plus(new Decimal(l.amount.toString())),
    new Decimal(0)
  );
  const expectedDelta = new Decimal(statement.closingBalance.toString()).minus(
    new Decimal(statement.openingBalance.toString())
  );
  const reconciles = sumOfLines.minus(expectedDelta).abs().lessThan(new Decimal("0.01"));

  // Progress summary: count lines by status. Drives the bulk-action
  // header + the % complete indicator. We count from the in-memory
  // lines array since the page already fetched them with status.
  const counts = {
    unmatched: 0,
    proposed: 0,
    matched: 0,
    ignored: 0,
    adjustment: 0,
  };
  for (const l of statement.lines) {
    const k = l.status.toLowerCase() as keyof typeof counts;
    if (k in counts) counts[k] += 1;
  }
  const resolvedCount = counts.matched + counts.ignored + counts.adjustment;
  const totalLines = statement.lines.length;
  const percentResolved =
    totalLines === 0 ? 100 : Math.round((resolvedCount / totalLines) * 100);
  const fullyResolved = totalLines > 0 && resolvedCount === totalLines;
  const isLocked = statement.status === "RECONCILED";
  const isAdmin = tenant ? canViewAdminPages(tenant.role) : false;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/statements" className="text-xs font-medium text-accent-600 hover:underline">
          ← All statements
        </Link>
        <h2 className="mt-2 text-xl font-semibold text-ink-900 font-mono">{statement.filename}</h2>
        <p className="text-sm text-ink-500">
          {statement.bankAccount.displayName} ({statement.bankAccount.code}) · {formatDate(statement.periodStart)} → {formatDate(statement.periodEnd)} · {statement.totalLines} lines
        </p>
      </div>

      {isLocked && (
        <Card>
          <CardContent className="flex items-start justify-between gap-3 px-5 py-3 bg-emerald-50">
            <div>
              <div className="text-sm font-medium text-emerald-900">
                RECONCILED · locked
              </div>
              <p className="mt-0.5 text-xs text-emerald-700">
                Every mutation on this statement (suggest / approve / reject /
                ignore / adjustment) is refused.
                {statement.reconciledAt
                  ? ` Locked by ${statement.reconciledBy ?? "(unknown)"} on ${formatDate(statement.reconciledAt)}.`
                  : ""}
              </p>
            </div>
            {isAdmin && <ReopenButton statementId={statement.id} />}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-4">
          <Field label="Opening balance" value={formatMoney(statement.openingBalance.toString())} mono />
          <Field label="Closing balance" value={formatMoney(statement.closingBalance.toString())} mono />
          <Field label="Σ lines" value={formatMoney(sumOfLines)} mono />
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Reconciles
            </div>
            <Badge tone={reconciles ? "positive" : "negative"}>
              {reconciles ? "Σ = ΔBalance ✓" : "DRIFT"}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
                  Progress
                </span>
                {fullyResolved && !isLocked && (
                  <Badge tone="positive">All resolved</Badge>
                )}
                {isLocked && <Badge tone="positive">LOCKED</Badge>}
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums text-ink-900">
                  {percentResolved}%
                </span>
                <span className="text-xs text-ink-500">
                  {resolvedCount} of {totalLines} lines resolved
                </span>
              </div>
            </div>
            <div className="flex items-start gap-2">
              {/* Reconcile button: show when fully resolved + not yet
                  locked. Bulk-actions hidden when locked (mutations
                  refuse anyway). */}
              {fullyResolved && !isLocked && (
                <ReconcileButton statementId={statement.id} />
              )}
              {!isLocked && (
                <StatementBulkActions
                  statementId={statement.id}
                  unmatchedCount={counts.unmatched}
                  proposedCount={counts.proposed}
                />
              )}
            </div>
          </div>
          {/* Progress bar — width driven by percentResolved. */}
          <div className="h-2 w-full overflow-hidden rounded-full bg-ink-100">
            <div
              className={`h-full transition-all ${fullyResolved ? "bg-positive" : "bg-accent-500"}`}
              style={{ width: `${percentResolved}%` }}
            />
          </div>
          {/* Per-status counts. Hidden when totals are zero to keep noise out. */}
          <div className="flex flex-wrap gap-3 text-xs text-ink-500">
            {counts.unmatched > 0 && (
              <span>
                <span className="font-medium text-ink-700">{counts.unmatched}</span> unmatched
              </span>
            )}
            {counts.proposed > 0 && (
              <span>
                <span className="font-medium text-ink-700">{counts.proposed}</span> proposed
              </span>
            )}
            {counts.matched > 0 && (
              <span>
                <span className="font-medium text-ink-700">{counts.matched}</span> matched
              </span>
            )}
            {counts.adjustment > 0 && (
              <span>
                <span className="font-medium text-ink-700">{counts.adjustment}</span> adjustment
              </span>
            )}
            {counts.ignored > 0 && (
              <span>
                <span className="font-medium text-ink-700">{counts.ignored}</span> ignored
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Statement lines</CardTitle>
          <span className="text-xs text-ink-500">
            Click <span className="font-medium">Suggest matches</span> to run the deterministic + AI pipeline. Then approve or reject each proposal.
          </span>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <tr>
                <TH>#</TH>
                <TH>Date</TH>
                <TH>Description</TH>
                <TH className="text-right">Amount</TH>
                <TH>Status</TH>
                <TH>Action</TH>
              </tr>
            </THead>
            <TBody>
              {statement.lines.map((line) => {
                const proposals: ProposalView[] = line.matches.map((m) => {
                  const signed = new Decimal(m.journalLine.debit.toString()).minus(
                    new Decimal(m.journalLine.credit.toString())
                  );
                  return {
                    matchId: m.id,
                    journalLineId: m.journalLineId,
                    source: m.source,
                    confidence: m.confidence !== null ? Number(m.confidence.toString()) : null,
                    entryNumber: m.journalLine.entry.entryNumber,
                    entryMemo: m.journalLine.entry.memo,
                    entryDate: formatDate(m.journalLine.entry.documentDate),
                    signedAmount: formatMoney(signed),
                  };
                });
                return (
                  <TR key={line.id}>
                    <TD className="text-ink-400 align-top">{line.lineNo}</TD>
                    <TD className="text-ink-500 align-top">{formatDate(line.transactionDate)}</TD>
                    <TD className="text-ink-900 align-top">{line.description}</TD>
                    <TD
                      className={`amount-cell text-right align-top ${moneyClass(line.amount.toString())}`}
                    >
                      {formatMoney(line.amount.toString())}
                    </TD>
                    <TD className="align-top">
                      <Badge
                        tone={
                          line.status === "MATCHED"
                            ? "positive"
                            : line.status === "PROPOSED"
                              ? "info"
                              : line.status === "IGNORED"
                                ? "neutral"
                                : line.status === "ADJUSTMENT"
                                  ? "warning"
                                  : "warning"
                        }
                      >
                        {line.status}
                      </Badge>
                    </TD>
                    <TD className="align-top">
                      <LineActions
                        bankLineId={line.id}
                        status={line.status}
                        proposals={proposals.filter((p) => p.source !== "MANUAL" || line.status === "PROPOSED")}
                      />
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">{label}</div>
      <div className={`mt-0.5 text-sm text-ink-800 ${mono ? "amount-cell" : ""}`}>{value}</div>
    </div>
  );
}
