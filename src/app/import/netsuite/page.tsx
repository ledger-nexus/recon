// /import/netsuite — paste an NS bank-reconciliation export bundle +
// import it as BankAccount + BankStatement + BankStatementLine +
// ReconciliationMatch rows.
//
// The interactive form lives in `ImportPanel` (client component);
// this Server Component is just the page chrome.

import { Card } from "@/components/ui/card";
import { ImportPanel } from "./import-panel";

export default function NsImportPage() {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">
          Import NetSuite bank reconciliation
        </h1>
        <p className="mt-1 text-sm text-ink-600">
          Paste a NetSuite bank-reconciliation export bundle below.
          Each statement becomes one <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">BankStatement</code> + its lines + <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">ReconciliationMatch</code> rows for any pre-existing matches.
          Re-imports are safe: filename-based dedup (<code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">ns-{`{internalid}`}.json</code>) returns <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">wasDuplicate</code>.
        </p>
      </header>

      <Card className="p-5">
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-ink-800">
            Bundle shape + prerequisites
          </summary>
          <div className="mt-3 space-y-3 text-ink-600">
            <p className="text-xs">
              <strong className="text-ink-800">Prereqs:</strong> NetSuite subsidiaries must be bootstrapped as <code className="rounded bg-ink-100 px-1 py-0.5">LegalEntity</code> rows
              (code: <code className="rounded bg-ink-100 px-1 py-0.5">NSSUB-{`{internalid}`}</code>) and NS GL Accounts must be bootstrapped with the lineage triple <code className="rounded bg-ink-100 px-1 py-0.5">(netsuite, Account, internalid)</code>. Both come from ledger-core&apos;s universal NetSuite mapper.
            </p>
            <p>
              The top-level shape is{" "}
              <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">NsReconExport</code>:
            </p>
            <pre className="overflow-x-auto rounded bg-ink-50 p-3 text-xs leading-relaxed text-ink-700">{`{
  "exported_at": "2026-06-05T00:00:00Z",
  "account_id": "your-ns-account-id",
  "bank_accounts": [
    {
      "internalid": "ba-100",
      "name": "Chase Operating ****1234",
      "gl_account_id": { "internalid": "acct-1000" },
      "subsidiary": { "internalid": "sub-1" },
      "currency": "USD"
    }
  ],
  "statements": [
    {
      "internalid": "stmt-500",
      "bank_account": { "internalid": "ba-100" },
      "period_start": "2026-03-01",
      "period_end": "2026-03-31",
      "opening_balance": 50000,
      "closing_balance": 51200,
      "currency": "USD",
      "lines": [
        {
          "internalid": "ln-1",
          "line_no": 1,
          "transaction_date": "2026-03-15",
          "description": "ACH Credit",
          "amount": 1200,
          "matched_transaction_type": "payment",
          "matched_transaction_id": "pay-9001",
          "reconciled": true
        }
      ]
    }
  ]
}`}</pre>
            <p className="text-xs">
              <strong className="text-ink-800">The translation rule:</strong> a line WITH <code className="rounded bg-ink-100 px-1 py-0.5">matched_transaction_id</code> becomes a <code className="rounded bg-ink-100 px-1 py-0.5">ReconciliationMatch</code> with <code className="rounded bg-ink-100 px-1 py-0.5">source=MANUAL, status=APPROVED</code> — preserving NetSuite&apos;s human-approved match verbatim. Lines WITHOUT a match land as <code className="rounded bg-ink-100 px-1 py-0.5">UNMATCHED</code>; recon&apos;s downstream matcher proposes new ones.
            </p>
            <p className="text-xs">
              <strong className="text-ink-800">Graceful degradation:</strong> if a <code className="rounded bg-ink-100 px-1 py-0.5">matched_transaction_id</code> points at a GL document that hasn&apos;t been imported yet, the match is skipped with a warning. The bank line still lands; a follow-up reconciliation pass after the GL import creates the match.
            </p>
          </div>
        </details>
      </Card>

      <ImportPanel />
    </div>
  );
}
