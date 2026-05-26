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
import { Input } from "@/components/ui/input";
import { proposeMatchesAction } from "@/app/actions/propose-matches";
import { approveMatchAction, rejectMatchAction } from "@/app/actions/decide-match";
import { postAdjustmentAction } from "@/app/actions/post-adjustment";
import { ignoreLineAction, unignoreLineAction } from "@/app/actions/ignore-line";

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
  const [success, setSuccess] = useState<string | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjAccount, setAdjAccount] = useState("");
  const [adjMemo, setAdjMemo] = useState("");
  const [ignoreOpen, setIgnoreOpen] = useState(false);
  const [ignoreReason, setIgnoreReason] = useState("");

  function clearStatus() {
    setError(null);
    setSuccess(null);
  }

  function onIgnore() {
    clearStatus();
    startTransition(async () => {
      const res = await ignoreLineAction({
        bankLineId,
        reason: ignoreReason.trim() || undefined,
      });
      if (!res.ok) {
        setError(res.message);
      } else {
        setSuccess(res.message);
        setIgnoreOpen(false);
        setIgnoreReason("");
      }
    });
  }

  function onUnignore() {
    clearStatus();
    startTransition(async () => {
      const res = await unignoreLineAction(bankLineId);
      if (!res.ok) setError(res.message);
      else setSuccess(res.message);
    });
  }

  function onSuggest() {
    clearStatus();
    startTransition(async () => {
      const res = await proposeMatchesAction(bankLineId);
      if (!res.ok) setError(res.message);
    });
  }

  function onApprove(matchId: string) {
    clearStatus();
    startTransition(async () => {
      const res = await approveMatchAction(matchId);
      if (!res.ok) setError(res.message);
    });
  }

  function onReject(matchId: string) {
    clearStatus();
    startTransition(async () => {
      const res = await rejectMatchAction(matchId);
      if (!res.ok) setError(res.message);
    });
  }

  function onAdjust() {
    clearStatus();
    if (!adjAccount.trim()) {
      setError("Counter-account code is required (e.g. 6500 for bank fees)");
      return;
    }
    startTransition(async () => {
      const res = await postAdjustmentAction({
        bankLineId,
        counterAccountCode: adjAccount.trim(),
        memo: adjMemo.trim() || undefined,
      });
      if (!res.ok) {
        setError(res.message);
      } else {
        setSuccess(res.message);
        setAdjustOpen(false);
        setAdjAccount("");
        setAdjMemo("");
      }
    });
  }

  if (status === "MATCHED") {
    return <span className="text-xs text-ink-400">approved</span>;
  }
  if (status === "ADJUSTMENT") {
    return <span className="text-xs text-ink-400">adjustment posted</span>;
  }
  if (status === "IGNORED") {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={onUnignore}
          disabled={pending}
        >
          {pending ? "Working…" : "Restore"}
        </Button>
        {error ? <span className="text-[11px] text-negative">{error}</span> : null}
        {success ? <span className="text-[11px] text-positive">{success}</span> : null}
      </div>
    );
  }

  if (status === "UNMATCHED" || proposals.length === 0) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onSuggest} disabled={pending}>
            {pending ? "Thinking…" : "Suggest matches"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              clearStatus();
              setAdjustOpen((v) => !v);
              setIgnoreOpen(false);
            }}
            disabled={pending}
          >
            {adjustOpen ? "Cancel adjust" : "Post adjustment"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              clearStatus();
              setIgnoreOpen((v) => !v);
              setAdjustOpen(false);
            }}
            disabled={pending}
          >
            {ignoreOpen ? "Cancel ignore" : "Ignore"}
          </Button>
        </div>
        {adjustOpen ? (
          <div className="flex w-72 flex-col gap-1.5 rounded-md border border-ink-200 bg-white p-2">
            <div className="text-[11px] text-ink-500">
              Posts a two-line JE through ledger-core: cash + counter-account, signed to match the bank line.
            </div>
            <Input
              placeholder="Counter account code (e.g. 6500)"
              value={adjAccount}
              onChange={(e) => setAdjAccount(e.target.value)}
              disabled={pending}
            />
            <Input
              placeholder="Memo (optional)"
              value={adjMemo}
              onChange={(e) => setAdjMemo(e.target.value)}
              disabled={pending}
            />
            <Button size="sm" onClick={onAdjust} disabled={pending}>
              {pending ? "Posting…" : "Post via ledger-core"}
            </Button>
          </div>
        ) : null}
        {ignoreOpen ? (
          <div className="flex w-72 flex-col gap-1.5 rounded-md border border-ink-200 bg-white p-2">
            <div className="text-[11px] text-ink-500">
              Mark this line as not requiring reconciliation (internal
              transfer, already booked, etc.). No JE posted.
            </div>
            <Input
              placeholder="Reason (optional but recommended)"
              value={ignoreReason}
              onChange={(e) => setIgnoreReason(e.target.value)}
              disabled={pending}
            />
            <Button size="sm" onClick={onIgnore} disabled={pending}>
              {pending ? "Working…" : "Mark IGNORED"}
            </Button>
          </div>
        ) : null}
        {error ? <span className="text-[11px] text-negative">{error}</span> : null}
        {success ? <span className="text-[11px] text-positive">{success}</span> : null}
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
