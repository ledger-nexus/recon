// Bank accounts list. Each BankAccount maps to a ledger-core Account
// with isBank=true. v0.1 is read-only; setup is via the seed script.

import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { getCurrentTenant } from "@/lib/auth/session";

export default async function BankAccountsPage() {
  // SECURITY (pen-test pass 4 follow-up): tenant-scope the enumeration.
  // Without this, the list would expose every tenant's bank account
  // names, last 4 digits, and linked ledger-core account codes.
  const tenant = await getCurrentTenant();
  const accounts = await prisma.bankAccount.findMany({
    where: tenant ? { entity: { tenantId: tenant.id } } : { id: "__none__" },
    orderBy: { code: "asc" },
    include: {
      entity: { select: { code: true, name: true } },
      account: { select: { code: true, name: true } },
      _count: { select: { statements: true } },
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Bank accounts</h2>
        <p className="text-sm text-ink-500">
          {accounts.length} configured. Each links a recon-side identifier to a ledger-core <code className="font-mono">Account</code> with <code className="font-mono">isBank=true</code>.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configured bank accounts</CardTitle>
        </CardHeader>
        <CardContent>
          {accounts.length === 0 ? (
            <EmptyState
              title="No bank accounts yet"
              description="Use the seed script or write a setup script that creates a BankAccount linked to a ledger-core isBank account."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Code</TH>
                  <TH>Display name</TH>
                  <TH>Bank</TH>
                  <TH>Last 4</TH>
                  <TH>Entity</TH>
                  <TH>Ledger-core account</TH>
                  <TH>Currency</TH>
                  <TH className="text-right">Statements</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <TBody>
                {accounts.map((a) => (
                  <TR key={a.id}>
                    <TD className="font-mono text-xs text-ink-700">{a.code}</TD>
                    <TD className="text-ink-900">{a.displayName}</TD>
                    <TD className="text-ink-500">{a.bankName ?? "—"}</TD>
                    <TD className="text-ink-500">{a.accountNumberLast4 ?? "—"}</TD>
                    <TD className="text-ink-700">
                      {a.entity.code} <span className="text-[11px] text-ink-400">— {a.entity.name}</span>
                    </TD>
                    <TD>
                      <span className="font-mono text-xs text-ink-700">{a.account.code}</span>{" "}
                      <span className="text-[11px] text-ink-400">{a.account.name}</span>
                    </TD>
                    <TD className="text-ink-500">{a.currencyId}</TD>
                    <TD className="text-right text-ink-700">{a._count.statements}</TD>
                    <TD>
                      <Badge tone={a.isActive ? "positive" : "neutral"}>
                        {a.isActive ? "active" : "inactive"}
                      </Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
