"use client";

// Reconcile + Reopen buttons for the statement detail page.
//
// Reconcile is shown when status=OPEN AND all lines have resolved.
// Reopen is shown when status=RECONCILED (admin-only on the server;
// the button is rendered for everyone but the action refuses
// non-admin callers).

import { useState, useTransition } from "react";
import {
  reconcileStatementAction,
  reopenStatementAction,
} from "@/app/actions/reconcile-statement";

export function ReconcileButton({
  statementId,
  disabled,
}: {
  statementId: string;
  disabled?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handle() {
    if (
      !confirm(
        "Reconcile this statement? Once locked, all mutations are refused until an admin reopens. Use when every line is genuinely settled — not as a checkpoint."
      )
    )
      return;
    setError(null);
    startTransition(async () => {
      const r = await reconcileStatementAction(statementId);
      if (!r.ok) setError(r.message ?? "Failed");
      // No need to handle success — revalidatePath refreshes the page.
    });
  }

  return (
    <div>
      <button
        onClick={handle}
        disabled={pending || disabled}
        className="h-8 inline-flex items-center rounded-md bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {pending ? "Locking..." : "Reconcile & lock"}
      </button>
      {error && (
        <div className="mt-1 text-[11px] text-negative">{error}</div>
      )}
    </div>
  );
}

export function ReopenButton({ statementId }: { statementId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [expanded, setExpanded] = useState(false);

  function handle(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setError("Add a reason for the audit trail.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await reopenStatementAction(statementId, reason.trim());
      if (!r.ok) setError(r.message ?? "Failed");
    });
  }

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="h-8 inline-flex items-center rounded-md border border-ink-300 bg-white px-3 text-xs font-medium text-ink-700 hover:bg-ink-50"
      >
        Reopen (admin)
      </button>
    );
  }

  return (
    <form onSubmit={handle} className="flex items-end gap-2">
      <div>
        <label className="text-[11px] font-medium text-ink-700">
          Reason for reopening
        </label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Vendor sent revised statement"
          className="mt-0.5 w-64 rounded-md border border-ink-300 bg-white px-2 py-1 text-xs focus:border-accent-500 focus:outline-none"
          disabled={pending}
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="h-8 inline-flex items-center rounded-md bg-ink-900 px-3 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-50"
      >
        {pending ? "Reopening..." : "Reopen"}
      </button>
      <button
        type="button"
        onClick={() => {
          setExpanded(false);
          setReason("");
          setError(null);
        }}
        className="h-8 inline-flex items-center text-xs text-ink-500 hover:underline"
        disabled={pending}
      >
        Cancel
      </button>
      {error && (
        <div className="basis-full text-[11px] text-negative">{error}</div>
      )}
    </form>
  );
}
