"use client";

// Client-side action controls for one bank statement line.
//
// Three modes:
//   - UNMATCHED: show "Suggest matches" (calls proposeMatchesAction)
//   - PROPOSED: show each match with Approve / Reject buttons
//   - MATCHED: no controls (the approved match is rendered elsewhere)
//
// Server Actions are imported and called directly from the click handler.
// useTransition keeps the row interactive during the round-trip and gives
// us a pending state for the buttons.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { proposeMatchesAction } from "@/app/actions/propose-matches";
import { approveMatchAction, rejectMatchAction } from "@/app/actions/decide-match";

export interface ProposalView {
  matchId: string;
  journalLineId: string;
  source: "DETERMINISTIC" | "AI" | "MANUAL";
  confidence: number | null;
  entryNumber: string;
  entryMemo: string;
  entryDate: string;
  signedAmount: string;
}

interface Props {
  bankLineId: string;
  status: "UNMATCHED" | "PROPOSED" | "MATCHED" | "IGNORED" | "ADJUSTMENT";
  proposals: ProposalView[];
}

export function LineActions({ bankLineId, status, proposals }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSuggest() {
    setError(null);
    startTransition(async () => {
      const res = await proposeMatchesAction(bankLineId);
      if (!res.ok) setError(res.message);
    });
  }

  function onApprove(matchId: string) {
    setError(null);
    startTransition(async () => {
      const res = await approveMatchAction(matchId);
      if (!res.ok) setError(res.message);
    });
  }

  function onReject(matchId: string) {
    setError(null);
    startTransition(async () => {
      const res = await rejectMatchAction(matchId);
      if (!res.ok) setError(res.message);
    });
  }

  if (status === "MATCHED") {
    return <span className="text-xs text-ink-400">approved</span>;
  }
  if (status === "IGNORED" || status === "ADJUSTMENT") {
    return <span className="text-xs text-ink-400">—</span>;
  }

  if (status === "UNMATCHED" || proposals.length === 0) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          size="sm"
          variant="outline"
          onClick={onSuggest}
          disabled={pending}
        >
          {pending ? "Thinking…" : "Suggest matches"}
        </Button>
        {error ? <span className="text-[11px] text-negative">{error}</span> : null}
      </div>
    );
  }

  // PROPOSED — show ranked proposals with approve / reject.
  return (
    <div className="flex flex-col gap-2">
      {proposals.map((p) => (
        <div
          key={p.matchId}
          className="flex flex-col gap-1 rounded-md border border-ink-200 bg-ink-50 px-2 py-1.5"
        >
          <div className="flex items-center gap-2 text-xs">
            <Badge tone={p.source === "AI" ? "ai" : p.source === "MANUAL" ? "neutral" : "info"}>
              {p.source}
            </Badge>
            {p.confidence !== null ? (
              <span className="text-ink-500">
                conf {(p.confidence * 100).toFixed(0)}%
              </span>
            ) : null}
            <span className="font-mono text-ink-700">{p.entryNumber}</span>
            <span className="amount-cell text-ink-700">{p.signedAmount}</span>
            <span className="text-ink-500">·</span>
            <span className="text-ink-500">{p.entryDate}</span>
          </div>
          <div className="text-xs text-ink-600">{p.entryMemo}</div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => onApprove(p.matchId)} disabled={pending}>
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onReject(p.matchId)}
              disabled={pending}
            >
              Reject
            </Button>
          </div>
        </div>
      ))}
      {error ? <span className="text-[11px] text-negative">{error}</span> : null}
    </div>
  );
}
