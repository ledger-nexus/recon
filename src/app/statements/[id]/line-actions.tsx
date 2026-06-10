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

import { useMemo, useState, useTransition } from "react";
import { Decimal } from "decimal.js";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { proposeMatchesAction } from "@/app/actions/propose-matches";
import { approveMatchAction, rejectMatchAction } from "@/app/actions/decide-match";
import { postMultiLineAdjustmentAction } from "@/app/actions/post-multi-line-adjustment";
import { ignoreLineAction, unignoreLineAction } from "@/app/actions/ignore-line";
import { computeRunningImbalance } from "@/lib/matching/multi-line-adjustment";

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
  status: "UNMATCHED" | "PROPOSED" | "MATCHED" | "IGNORED" | "ADJUSTMENT" | "VOID";
  proposals: ProposalView[];
  /** Signed bank-line amount as a string (positive = deposit, negative = withdrawal). */
  bankLineAmount: string;
  /** GL account code for the cash side of the JE. */
  cashAccountCode: string;
}

/**
 * One row in the operator-controlled portion of the adjustment editor.
 * The cash row is rendered separately (fixed, computed from the bank
 * line) and is NOT in this list.
 */
interface CounterLineDraft {
  /** Stable local id so React keys + delete-by-index work. */
  key: string;
  accountCode: string;
  side: "DEBIT" | "CREDIT";
  /** Free-text amount; parsed into Decimal at validate time. */
  amount: string;
  partyCode: string;
  description: string;
}

export function LineActions({
  bankLineId,
  status,
  proposals,
  bankLineAmount,
  cashAccountCode,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjMemo, setAdjMemo] = useState("");
  const [counterLines, setCounterLines] = useState<CounterLineDraft[]>(() => [
    initialCounterDraft(bankLineAmount),
  ]);
  const [ignoreOpen, setIgnoreOpen] = useState(false);
  const [ignoreReason, setIgnoreReason] = useState("");

  // Live balance check on every keystroke. The validator is the source
  // of truth at submit time; this just gives the operator early feedback.
  const balance = useMemo(
    () =>
      computeRunningImbalance({
        cashAccountCode,
        bankLineAmount,
        counterLines: counterLines.map((c) => ({
          accountCode: c.accountCode,
          side: c.side,
          amount: c.amount.trim() === "" ? 0 : c.amount,
          partyCode: c.partyCode || null,
          description: c.description || null,
        })),
      }),
    [bankLineAmount, cashAccountCode, counterLines]
  );
  const cashSide = useMemo<"DEBIT" | "CREDIT">(() => {
    try {
      const v = new Decimal(bankLineAmount);
      return v.isPositive() ? "DEBIT" : "CREDIT";
    } catch {
      return "DEBIT";
    }
  }, [bankLineAmount]);
  const cashAbs = useMemo(() => {
    try {
      return new Decimal(bankLineAmount).abs().toFixed(2);
    } catch {
      return "0.00";
    }
  }, [bankLineAmount]);

  function addCounterLine() {
    setCounterLines((cur) => [...cur, initialCounterDraft(bankLineAmount, cur.length)]);
  }
  function removeCounterLine(key: string) {
    setCounterLines((cur) => (cur.length <= 1 ? cur : cur.filter((c) => c.key !== key)));
  }
  function updateCounterLine(key: string, patch: Partial<CounterLineDraft>) {
    setCounterLines((cur) => cur.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }
  function resetAdjustForm() {
    setCounterLines([initialCounterDraft(bankLineAmount)]);
    setAdjMemo("");
  }

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
    // Soft client-side check; the action validates authoritatively.
    if (!balance.imbalance.isZero()) {
      setError(
        `Lines don't balance: ${balance.totalDebits.toFixed(2)} DR vs ${balance.totalCredits.toFixed(2)} CR (off by ${balance.imbalance.abs().toFixed(2)})`
      );
      return;
    }
    if (counterLines.some((c) => !c.accountCode.trim() || !c.amount.trim())) {
      setError("Every line needs an account code and an amount");
      return;
    }
    startTransition(async () => {
      const res = await postMultiLineAdjustmentAction({
        bankLineId,
        memo: adjMemo.trim() || undefined,
        counterLines: counterLines.map((c) => ({
          accountCode: c.accountCode.trim(),
          side: c.side,
          amount: c.amount.trim(),
          partyCode: c.partyCode.trim() || null,
          description: c.description.trim() || null,
        })),
      });
      if (!res.ok) {
        setError(res.message);
      } else {
        setSuccess(res.message);
        setAdjustOpen(false);
        resetAdjustForm();
      }
    });
  }

  if (status === "MATCHED") {
    return <span className="text-xs text-ink-400">approved</span>;
  }
  if (status === "ADJUSTMENT") {
    return <span className="text-xs text-ink-400">adjustment posted</span>;
  }
  if (status === "VOID") {
    // Upstream bank cancelled the transaction. The row stays in the
    // statement for the audit trail; no further actions are
    // applicable. If an APPROVED match exists, the operator may need
    // to reverse the JE manually — that's surfaced via the
    // /api/internal/bank-lines response (approvedMatchesAffected).
    return <span className="text-xs text-rose-700">voided by upstream</span>;
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
          <div className="flex w-[28rem] flex-col gap-2 rounded-md border border-ink-200 bg-white p-3 text-left">
            <div className="text-[11px] text-ink-500">
              Multi-line adjustment JE via ledger-core. Cash side is fixed by
              the bank line; add as many counter lines as needed (e.g., split
              deposit net of fees, bundled vendor wire). Σ DR must equal Σ CR.
            </div>

            {/* Cash row — fixed, computed from the bank line */}
            <div className="grid grid-cols-[1fr_64px_96px_1fr_24px] items-center gap-1.5 border-b border-dashed border-ink-200 pb-1.5">
              <Input
                value={cashAccountCode}
                disabled
                title="Cash GL account (from the bank account config)"
              />
              <Badge tone="neutral">{cashSide}</Badge>
              <Input
                value={cashAbs}
                disabled
                className="amount-cell text-right"
                title="Absolute bank-line amount; sign drives DR/CR side"
              />
              <span className="text-[11px] text-ink-500">cash (auto)</span>
              <span />
            </div>

            {/* Operator-controlled counter rows */}
            {counterLines.map((c, i) => (
              <div
                key={c.key}
                className="grid grid-cols-[1fr_64px_96px_1fr_24px] items-center gap-1.5"
              >
                <Input
                  placeholder="Account (e.g. 6500)"
                  value={c.accountCode}
                  onChange={(e) =>
                    updateCounterLine(c.key, { accountCode: e.target.value })
                  }
                  disabled={pending}
                />
                <select
                  className="h-9 rounded-md border border-ink-200 bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ink-300"
                  value={c.side}
                  onChange={(e) =>
                    updateCounterLine(c.key, {
                      side: e.target.value as "DEBIT" | "CREDIT",
                    })
                  }
                  disabled={pending}
                >
                  <option value="DEBIT">DR</option>
                  <option value="CREDIT">CR</option>
                </select>
                <Input
                  placeholder="Amount"
                  type="text"
                  inputMode="decimal"
                  value={c.amount}
                  onChange={(e) =>
                    updateCounterLine(c.key, { amount: e.target.value })
                  }
                  disabled={pending}
                  className="amount-cell text-right"
                />
                <Input
                  placeholder="Party (optional)"
                  value={c.partyCode}
                  onChange={(e) =>
                    updateCounterLine(c.key, { partyCode: e.target.value })
                  }
                  disabled={pending}
                />
                <button
                  type="button"
                  onClick={() => removeCounterLine(c.key)}
                  disabled={pending || counterLines.length <= 1}
                  className="text-ink-400 hover:text-rose-600 disabled:opacity-40"
                  title="Remove this line"
                  aria-label={`Remove line ${i + 2}`}
                >
                  ×
                </button>
              </div>
            ))}

            <div className="flex items-center justify-between gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={addCounterLine}
                disabled={pending}
              >
                + Add line
              </Button>
              <BalanceIndicator
                totalDr={balance.totalDebits.toFixed(2)}
                totalCr={balance.totalCredits.toFixed(2)}
                imbalance={balance.imbalance.toFixed(2)}
              />
            </div>

            <Input
              placeholder="Memo (optional)"
              value={adjMemo}
              onChange={(e) => setAdjMemo(e.target.value)}
              disabled={pending}
            />
            <Button
              size="sm"
              onClick={onAdjust}
              disabled={pending || !balance.imbalance.isZero()}
            >
              {pending ? "Posting…" : `Post ${counterLines.length + 1}-line JE via ledger-core`}
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let _counterKeySeq = 0;
function nextCounterKey(): string {
  _counterKeySeq += 1;
  return `cl-${_counterKeySeq}`;
}

/**
 * First counter line is pre-populated with the absolute bank-line amount
 * on the side opposite the cash line. That's the single-counter case —
 * the most common starting point. Operators add more lines from there.
 *
 * Subsequent lines (index > 0) start blank so the operator types the
 * amount; the running-balance indicator updates live.
 */
function initialCounterDraft(
  bankLineAmount: string,
  existingCount = 0
): CounterLineDraft {
  if (existingCount > 0) {
    return {
      key: nextCounterKey(),
      accountCode: "",
      side: "DEBIT",
      amount: "",
      partyCode: "",
      description: "",
    };
  }
  let amount = "";
  let side: "DEBIT" | "CREDIT" = "CREDIT";
  try {
    const signed = new Decimal(bankLineAmount);
    if (!signed.isZero()) {
      amount = signed.abs().toFixed(2);
      // Counter is opposite the cash side: deposit → cash DR → counter CR.
      side = signed.isPositive() ? "CREDIT" : "DEBIT";
    }
  } catch {
    // bankLineAmount unparseable — leave blanks; the operator can fix.
  }
  return {
    key: nextCounterKey(),
    accountCode: "",
    side,
    amount,
    partyCode: "",
    description: "",
  };
}

function BalanceIndicator({
  totalDr,
  totalCr,
  imbalance,
}: {
  totalDr: string;
  totalCr: string;
  imbalance: string;
}) {
  const off = parseFloat(imbalance);
  const balanced = off === 0;
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-ink-500">
        DR <span className="amount-cell text-ink-700">{totalDr}</span>
        {" · "}
        CR <span className="amount-cell text-ink-700">{totalCr}</span>
      </span>
      <Badge tone={balanced ? "positive" : "warning"}>
        {balanced
          ? "balanced ✓"
          : `off by ${Math.abs(off).toFixed(2)} ${off > 0 ? "DR" : "CR"}`}
      </Badge>
    </div>
  );
}
