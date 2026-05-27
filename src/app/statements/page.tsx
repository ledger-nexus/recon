// List of uploaded bank statements.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney } from "@/lib/utils/format";
import { getCurrentTenant } from "@/lib/auth/session";

export default async function StatementsPage() {
  // SECURITY (pen-test pass 4 follow-up): tenant-scope the enumeration.
  // Without this filter, the list would surface every tenant's bank
  // statements with bank account name + balance information.
  const tenant = await getCurrentTenant();
  const statements = await prisma.bankStatement.findMany({
    where: tenant
      ? { bankAccount: { entity: { tenantId: tenant.id } } }
      : { id: "__none__" },
    orderBy: { uploadedAt: "desc" },
    include: { bankAccount: { select: { displayName: true, code: true } } },
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">Bank statements</h2>
          <p className="text-sm text-ink-500">
            {statements.length} statement{statements.length === 1 ? "" : "s"} uploaded
          </p>
        </div>
        <Link
          href="/statements/new"
          className="h-9 inline-flex items-center rounded-md bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-800"
        >
          Upload statement
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All statements</CardTitle>
        </CardHeader>
        <CardContent>
          {statements.length === 0 ? (
            <EmptyState
              title="No statements yet"
              description="Upload a bank CSV to start reconciling."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Filename</TH>
                  <TH>Bank account</TH>
                  <TH>Period</TH>
                  <TH>Format</TH>
                  <TH>Uploaded</TH>
                  <TH className="text-right">Lines</TH>
                  <TH className="text-right">Opening</TH>
                  <TH className="text-right">Closing</TH>
                  <TH>Progress</TH>
                </tr>
              </THead>
              <TBody>
                {statements.map((s) => {
                  const progress = s.totalLines > 0 ? Math.round((s.matchedLines / s.totalLines) * 100) : 0;
                  return (
                    <TR key={s.id}>
                      <TD>
                        <Link
                          href={`/statements/${s.id}`}
                          className="font-mono text-xs text-ink-900 hover:underline"
                        >
                          {s.filename}
                        </Link>
                      </TD>
                      <TD className="text-ink-700">
                        {s.bankAccount.displayName}{" "}
                        <span className="text-[11px] text-ink-400">({s.bankAccount.code})</span>
                      </TD>
                      <TD className="text-ink-500">
                        {formatDate(s.periodStart)} → {formatDate(s.periodEnd)}
                      </TD>
                      <TD>
                        <Badge tone="neutral">{s.format}</Badge>
                      </TD>
                      <TD className="text-ink-500">{formatDate(s.uploadedAt)}</TD>
                      <TD className="text-right text-ink-700">{s.totalLines}</TD>
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
