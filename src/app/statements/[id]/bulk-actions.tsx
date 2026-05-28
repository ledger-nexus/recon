"use client";

// Statement-level bulk actions. Lives at the top of the detail page,
// next to the progress summary. Three buttons:
//
//   - "Suggest for all unmatched" — runs the deterministic + AI pipeline
//     on every UNMATCHED line sequentially. Slow (a 9-line statement takes
//     ~15-30s) but cheap to operate; the AI cost-per-line is bounded by
//     prompt caching on the system prefix.
//
//   - "Apply matching rules" — runs every active MatchingRule against
//     UNMATCHED/PROPOSED lines. Each match either IGNORES the line or
//     posts an ADJUST JE via the bridge. Returns a per-line breakdown
//     the operator can review in the dialog.
//
//   - "Bulk approve high confidence" — approves every PROPOSED match
//     whose top candidate is at or above the configured threshold
//     (default 90%). One click closes out the obvious matches; the
//     operator only reviews the borderline ones.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  proposeAllUnmatchedAction,
  type ProposeAllState,
} from "@/app/actions/propose-matches";
import {
  applyRulesToStatementAction,
  bulkApproveHighConfidenceAction,
  type ApplyRulesResult,
  type BulkApproveResult,
} from "@/app/actions/apply-rules";

export function StatementBulkActions({
  statementId,
  unmatchedCount,
  proposedCount,
}: {
  statementId: string;
  unmatchedCount: number;
  proposedCount: number;
}) {
  const [pending, startTransition] = useTransition();
  const [suggestResult, setSuggestResult] = useState<ProposeAllState | null>(null);
  const [rulesResult, setRulesResult] = useState<ApplyRulesResult | null>(null);
  const [approveResult, setApproveResult] = useState<BulkApproveResult | null>(null);
  const [threshold, setThreshold] = useState(90);

  function clearAll() {
    setSuggestResult(null);
    setRulesResult(null);
    setApproveResult(null);
  }

  function onSuggestAll() {
    clearAll();
    startTransition(async () => {
      setSuggestResult(await proposeAllUnmatchedAction(statementId));
    });
  }

  function onApplyRules() {
    clearAll();
    startTransition(async () => {
      setRulesResult(await applyRulesToStatementAction(statementId));
    });
  }

  function onBulkApprove() {
    clearAll();
    startTransition(async () => {
      setApproveResult(
        await bulkApproveHighConfidenceAction({
          statementId,
          threshold: threshold / 100,
        })
      );
    });
  }

  const nothingToDo = unmatchedCount === 0 && proposedCount === 0;
  if (nothingToDo) {
    return (
      <span className="text-xs text-ink-500">Nothing to do — all lines resolved.</span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {unmatchedCount > 0 ? (
          <Button size="sm" variant="outline" onClick={onApplyRules} disabled={pending}>
            {pending && rulesResult === null
              ? "Applying rules…"
              : `Apply matching rules`}
          </Button>
        ) : null}
        {unmatchedCount > 0 ? (
          <Button size="sm" variant="outline" onClick={onSuggestAll} disabled={pending}>
            {pending && suggestResult === null
              ? `Thinking through ${unmatchedCount} line${unmatchedCount === 1 ? "" : "s"}…`
              : `Suggest matches for all ${unmatchedCount} unmatched`}
          </Button>
        ) : null}
        {proposedCount > 0 ? (
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] text-ink-500">
              ≥
              <input
                type="number"
                min="50"
                max="100"
                value={threshold}
                onChange={(e) => setThreshold(Math.max(50, Math.min(100, +e.target.value)))}
                className="mx-1 w-12 rounded border border-ink-200 px-1 text-right text-xs tabular-nums"
                disabled={pending}
              />
              % confidence
            </label>
            <Button size="sm" variant="outline" onClick={onBulkApprove} disabled={pending}>
              {pending && approveResult === null
                ? "Approving…"
                : `Bulk approve ${proposedCount} proposed`}
            </Button>
          </div>
        ) : null}
      </div>

      {suggestResult ? (
        <span
          className={`text-[11px] ${suggestResult.ok ? "text-ink-500" : "text-rose-700"}`}
        >
          {suggestResult.message}
        </span>
      ) : null}

      {rulesResult ? (
        <div className="flex max-w-md flex-col items-end gap-1">
          <span
            className={`text-[11px] ${rulesResult.ok ? "text-ink-500" : "text-rose-700"}`}
          >
            {rulesResult.message}
          </span>
          {rulesResult.lines.length > 0 ? (
            <details className="text-[11px] text-ink-500">
              <summary className="cursor-pointer hover:text-ink-700">
                Per-line detail ({rulesResult.lines.length})
              </summary>
              <ul className="mt-1 flex flex-col gap-0.5">
                {rulesResult.lines.map((l) => (
                  <li key={l.bankLineId} className="flex items-center gap-1.5">
                    <Badge
                      tone={
                        l.outcome === "IGNORED" || l.outcome === "ADJUSTED"
                          ? "positive"
                          : l.outcome === "FAILED"
                            ? "negative"
                            : "neutral"
                      }
                    >
                      {l.outcome}
                    </Badge>
                    <span className="truncate">{l.description}</span>
                    {l.ruleName ? (
                      <span className="text-ink-400">→ {l.ruleName}</span>
                    ) : null}
                    {l.entryNumber ? (
                      <span className="font-mono text-ink-400">{l.entryNumber}</span>
                    ) : null}
                    {l.error ? (
                      <span className="text-rose-700">— {l.error}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {approveResult ? (
        <div className="flex max-w-md flex-col items-end gap-1">
          <span
            className={`text-[11px] ${approveResult.ok ? "text-ink-500" : "text-rose-700"}`}
          >
            {approveResult.message}
          </span>
          {approveResult.failures.length > 0 ? (
            <details className="text-[11px] text-rose-700">
              <summary className="cursor-pointer">
                {approveResult.failures.length} failure(s)
              </summary>
              <ul className="mt-1 flex flex-col gap-0.5">
                {approveResult.failures.map((f) => (
                  <li key={f.matchId}>{f.reason}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
