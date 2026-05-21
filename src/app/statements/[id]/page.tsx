// Statement detail page. Shows every parsed line with its current match
// status. v0.1 is read-only — the interactive approve/reject UI for
// proposed matches lands in v0.2 alongside the AI suggester.

import Link from "next/link";
import { Decimal } from "decimal.js";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatMoney, moneyClass } from "@/lib/utils/format";

export default async function StatementDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const statement = await prisma.bankStatement.findUnique({
    where: { id: params.id },
    include: {
      bankAccount: { select: { displayName: true, code: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          matches: {
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
        <CardHeader>
          <CardTitle>Statement lines</CardTitle>
          <span className="text-xs text-ink-500">
            v0.1 is read-only. Interactive approve / reject + AI suggestions arrive in v0.2.
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
                <TH className="text-right">Running</TH>
                <TH>Status</TH>
                <TH>Match</TH>
              </tr>
            </THead>
            <TBody>
              {statement.lines.map((line) => {
                const topMatch = line.matches[0];
                return (
                  <TR key={line.id}>
                    <TD className="text-ink-400">{line.lineNo}</TD>
                    <TD className="text-ink-500">{formatDate(line.transactionDate)}</TD>
                    <TD className="text-ink-900">{line.description}</TD>
                    <TD
                      className={`amount-cell text-right ${moneyClass(line.amount.toString())}`}
                    >
                      {formatMoney(line.amount.toString())}
                    </TD>
                    <TD className="amount-cell text-right text-ink-500">
                      {line.runningBalance ? formatMoney(line.runningBalance.toString()) : "—"}
                    </TD>
                    <TD>
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
                    <TD className="text-xs">
                      {topMatch ? (
                        <span className="font-mono text-ink-700">
                          {topMatch.journalLine.entry.entryNumber}
                        </span>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
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
