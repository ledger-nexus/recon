"use client";

// Statement-level bulk actions. Lives at the top of the detail page,
// next to the progress summary. v1.0 ships:
//
//   - "Suggest for all unmatched" — runs the deterministic + AI pipeline
//     on every UNMATCHED line sequentially. Slow (a 9-line statement takes
//     ~15-30s) but cheap to operate; the AI cost-per-line is bounded by
//     prompt caching on the system prefix.
//
// Future additions (v1.1+): bulk-approve, bulk-ignore by description.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  proposeAllUnmatchedAction,
  type ProposeAllState,
} from "@/app/actions/propose-matches";

export function StatementBulkActions({
  statementId,
  unmatchedCount,
}: {
  statementId: string;
  unmatchedCount: number;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ProposeAllState | null>(null);

  function onSuggestAll() {
    setResult(null);
    startTransition(async () => {
      const res = await proposeAllUnmatchedAction(statementId);
      setResult(res);
    });
  }

  if (unmatchedCount === 0) {
    return (
      <span className="text-xs text-ink-500">
        Nothing to do — all lines resolved.
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        onClick={onSuggestAll}
        disabled={pending}
      >
        {pending
          ? `Thinking through ${unmatchedCount} line${unmatchedCount === 1 ? "" : "s"}…`
          : `Suggest matches for all ${unmatchedCount} unmatched`}
      </Button>
      {result && result.ok && (
        <span className="text-[11px] text-ink-500">{result.message}</span>
      )}
      {result && !result.ok && (
        <span className="text-[11px] text-negative">{result.message}</span>
      )}
    </div>
  );
}
