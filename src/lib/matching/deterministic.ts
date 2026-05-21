// Deterministic match scoring.
//
// Given a bank statement line and a list of candidate JE lines from
// ledger-core, scores each candidate by:
//   1. Amount equality (exact > $0.01 tolerance)
//   2. Date proximity (same day > ±1 day > ±5 days > beyond)
//   3. Party / counterparty hint match (description contains party name)
//
// Returns an ordered list of candidates with a 0..1 score. The threshold
// for auto-proposing is 0.85 — below that, the AI suggester (v0.2) is
// the next line of defense.
//
// The function is intentionally pure (no DB access) so it can be unit-
// tested with fixtures and reused by the AI suggester as a feature-
// engineering helper.

import { Decimal } from "decimal.js";

export interface MatchCandidateInput {
  // Bank line side
  bankAmount: Decimal;          // signed (positive = deposit)
  bankDate: Date;
  bankDescription: string;

  // JE-line side
  journalLineId: string;
  jeDebit: Decimal;
  jeCredit: Decimal;
  jeDate: Date;
  jeMemo: string;
  jePartyDisplayName?: string;  // counterparty name from party.displayName
  jePartyCode?: string;
}

export interface MatchScore {
  journalLineId: string;
  score: number;                // 0..1
  components: {
    amountScore: number;        // 0 (no match) or 1 (exact)
    dateScore: number;          // 1 (same day) → 0 (>5 days)
    descriptionScore: number;   // 0..1 based on shared tokens
  };
  rationale: string;
}

const AMOUNT_TOLERANCE = new Decimal("0.01");
const MAX_DAY_DELTA_FOR_SCORE = 5;

function daysBetween(a: Date, b: Date): number {
  return Math.abs(Math.floor((a.getTime() - b.getTime()) / 86400000));
}

// JE line signed amount: debit positive, credit negative. Bank line amount
// is signed too (positive = deposit / cash debit). For an exact match we
// expect them to align: bank deposit = cash JE debit (positive); bank
// withdrawal = cash JE credit (negative).
function jeSigned(jeDebit: Decimal, jeCredit: Decimal): Decimal {
  return jeDebit.minus(jeCredit);
}

function tokenize(s: string): string[] {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function descriptionScore(bankDesc: string, jeMemo: string, party?: string): number {
  const bankTokens = new Set(tokenize(bankDesc));
  const jeTokens = new Set(tokenize(jeMemo));
  const partyTokens = party ? new Set(tokenize(party)) : new Set<string>();

  let hits = 0;
  for (const t of bankTokens) {
    if (jeTokens.has(t) || partyTokens.has(t)) hits += 1;
  }
  // Normalize by smaller-side token count so a 1-token JE matching 1
  // token of a 30-token bank desc still scores well.
  const denom = Math.max(1, Math.min(bankTokens.size, jeTokens.size + partyTokens.size));
  return Math.min(1, hits / denom);
}

export function scoreCandidate(input: MatchCandidateInput): MatchScore {
  const jeAmt = jeSigned(input.jeDebit, input.jeCredit);
  const amtDiff = input.bankAmount.minus(jeAmt).abs();
  const amountScore = amtDiff.lessThanOrEqualTo(AMOUNT_TOLERANCE) ? 1 : 0;

  const dayDelta = daysBetween(input.bankDate, input.jeDate);
  const dateScore = Math.max(0, 1 - dayDelta / MAX_DAY_DELTA_FOR_SCORE);

  const descScore = descriptionScore(input.bankDescription, input.jeMemo, input.jePartyDisplayName);

  // Weighted sum. Amount dominates — a wrong-amount match is never
  // useful no matter how close the date / description.
  const score = amountScore === 0 ? 0 : 0.6 * amountScore + 0.25 * dateScore + 0.15 * descScore;

  const rationale =
    amountScore === 0
      ? `Amount mismatch ($${amtDiff.toFixed(2)} off)`
      : dayDelta === 0
        ? `Exact amount, same date${descScore > 0 ? `, description overlap` : ""}`
        : `Exact amount, ${dayDelta} day${dayDelta === 1 ? "" : "s"} off${descScore > 0 ? `, description overlap` : ""}`;

  return {
    journalLineId: input.journalLineId,
    score,
    components: { amountScore, dateScore, descriptionScore: descScore },
    rationale,
  };
}

// Convenience: score many candidates against one bank line, return them
// in descending score order. Caller decides whether to auto-propose the
// top result.
export function rankCandidates(
  bankLine: { amount: Decimal; date: Date; description: string },
  candidates: Omit<MatchCandidateInput, "bankAmount" | "bankDate" | "bankDescription">[]
): MatchScore[] {
  const scored = candidates.map((c) =>
    scoreCandidate({
      ...c,
      bankAmount: bankLine.amount,
      bankDate: bankLine.date,
      bankDescription: bankLine.description,
    })
  );
  return scored.sort((a, b) => b.score - a.score);
}

export const AUTO_PROPOSE_THRESHOLD = 0.85;
