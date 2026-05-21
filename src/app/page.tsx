// Dashboard — recon's first-impression page. Shows what needs attention:
// statements pending review, unmatched bank lines, recent statements.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney } from "@/lib/utils/format";

export default async function DashboardPage() {
  const [statements, unmatchedCount, totalLines, accounts] = await Promise.all([
    prisma.bankStatement.findMany({
      orderBy: { uploadedAt: "desc" },
      take: 10,
      include: { bankAccount: { select: { displayName: true, code: true } } },
    }),
    prisma.bankStatementLine.count({ where: { status: "UNMATCHED" } }),
    prisma.bankStatementLine.count(),
    prisma.bankAccount.count(),
  ]);

  if (statements.length === 0 && accounts === 0) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold text-ink-900">Welcome to recon</h2>
        <Card>
          <CardContent className="px-5 py-4">
            <p className="text-sm text-ink-700">
              This is the bank-reconciliation companion to <span className="font-mono">ledger-core</span>. The
              workflow:
            </p>
            <ol className="mt-3 list-decimal pl-5 text-sm text-ink-700">
              <li className="mb-1">Map a bank account → ledger-core <code>Account</code> with <code>isBank=true</code>.</li>
              <li className="mb-1">Upload a CSV statement.</li>
              <li className="mb-1">Recon proposes matches (deterministic now; AI in v0.2).</li>
              <li className="mb-1">Human approves; ledger-core's <code>postJournalEntry</code> books adjustments via <code>source: AI_APPROVED</code>.</li>
            </ol>
            <div className="mt-4">
              <Link
                href="/accounts"
                className="text-xs font-medium text-accent-600 hover:underline"
              >
                Set up your first bank account →
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Dashboard</h2>
        <p className="text-sm text-ink-500">
          {accounts} bank account{accounts === 1 ? "" : "s"} · {statements.length} recent statement
          {statements.length === 1 ? "" : "s"} · {unmatchedCount} unmatched line
          {unmatchedCount === 1 ? "" : "s"}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="px-5 py-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Statements
            </div>
            <div className="mt-1 text-xl font-semibold text-ink-900">{statements.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="px-5 py-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Lines total
            </div>
            <div className="mt-1 text-xl font-semibold text-ink-900">{totalLines}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="px-5 py-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Unmatched
            </div>
            <div className={`mt-1 text-xl font-semibold ${unmatchedCount > 0 ? "text-warning" : "text-positive"}`}>
              {unmatchedCount}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="px-5 py-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Bank accounts
            </div>
            <div className="mt-1 text-xl font-semibold text-ink-900">{accounts}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent statements</CardTitle>
          <Link href="/statements" className="text-xs font-medium text-accent-600 hover:underline">
            View all →
          </Link>
        </CardHeader>
        <CardContent>
          {statements.length === 0 ? (
            <EmptyState
              title="No statements uploaded yet"
              description="Upload a CSV from your bank to start reconciling."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Filename</TH>
                  <TH>Bank account</TH>
                  <TH>Period</TH>
                  <TH className="text-right">Opening</TH>
                  <TH className="text-right">Closing</TH>
                  <TH>Match progress</TH>
                </tr>
              </THead>
              <TBody>
                {statements.map((s) => {
                  const progress = s.totalLines > 0 ? Math.round((s.matchedLines / s.totalLines) * 100) : 0;
                  return (
                    <TR key={s.id}>
                      <TD>
                        <Link href={`/statements/${s.id}`} className="font-mono text-xs text-ink-900 hover:underline">
                          {s.filename}
                        </Link>
                      </TD>
                      <TD className="text-ink-700">
                        {s.bankAccount.displayName} <span className="text-[11px] text-ink-400">({s.bankAccount.code})</span>
                      </TD>
                      <TD className="text-ink-500">
                        {formatDate(s.periodStart)} → {formatDate(s.periodEnd)}
                      </TD>
                      <TD className="amount-cell text-right">{formatMoney(s.openingBalance.toString())}</TD>
                      <TD className="amount-cell text-right">{formatMoney(s.closingBalance.toString())}</TD>
                      <TD>
                        <Badge tone={progress === 100 ? "positive" : progress >= 50 ? "info" : "warning"}>
                          {s.matchedLines}/{s.totalLines} ({progress}%)
                        </Badge>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
