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
