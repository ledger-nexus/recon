import Link from "next/link";
import { prisma } from "@/lib/db";
import { EmptyState } from "@/components/ui/empty-state";
import { UploadStatementForm } from "./upload-form";

export default async function NewStatementPage() {
  const accounts = await prisma.bankAccount.findMany({
    where: { isActive: true },
    orderBy: { code: "asc" },
    select: { id: true, code: true, displayName: true },
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Upload bank statement</h2>
        <p className="text-sm text-ink-500">
          Paste or upload a CSV. The parser checks that Σ lines = closing − opening before persisting — bad files fail loud.
        </p>
      </div>

      {accounts.length === 0 ? (
        <EmptyState
          title="No bank accounts configured"
          description="Add a bank account first — it maps to a ledger-core Account with isBank=true."
        />
      ) : (
        <UploadStatementForm bankAccounts={accounts} />
      )}
    </div>
  );
}
