// Rule conflict detection. Pure functions, no DB.
//
// Heavy users build up rule libraries with overlapping patterns. The
// first-match-wins engine in rules.ts always picks ONE rule per line,
// but the operator never sees the rules that were silently dropped on
// the floor. The classic confusion:
//
//   Priority 50: descriptionRegex = "STRIPE", action = IGNORE
//   Priority 100: descriptionRegex = "STRIPE PAYOUT", action = ADJUST → 1200
//
// The lower-priority specific rule never fires because the
// higher-priority permissive rule always wins. Operator scratches
// their head: "why aren't my Stripe payouts being classified?"
//
// This module detects the situation at rule-edit time. It can't
// solve the general regex-equivalence problem (undecidable), but
// the practically-useful case — literal-substring subsumption — is
// what 90% of CPA rules look like ("STRIPE", "ZELLE FROM JOHN",
// "ATM WITHDRAWAL"). We focus on that.
//
// Conflict types reported:
//
//   SHADOWED  — rule B is dead code. A higher-priority rule A
//               matches a SUPERSET of what B matches; every line B
//               would match is claimed by A first.
//   OVERLAP   — rules A and B have an overlapping match set but
//               neither subsumes the other (e.g., partially-
//               overlapping amount ranges). Both can fire on
//               different lines, but the operator should review.
//   DUPLICATE — two rules with identical pattern + amount range +
//               entity scope. Lower priority is dead; the higher
//               one is the canonical version.

import { Decimal } from "decimal.js";
import type { RuleSpec } from "./rules";

/**
 * Detects whether a regex string is "essentially literal" — no regex
 * metacharacters that would make it match more than its literal text.
 * We err on the side of treating ambiguous patterns as non-literal
 * (skipping the analysis) to avoid false-positive conflict reports.
 *
 * Allowed in a "literal" pattern: letters, digits, spaces, hyphens,
 * underscores, the common bank-statement punctuation. Anything
 * regex-special bails.
 */
export function isLiteralPattern(pattern: string): boolean {
  if (pattern.length === 0) return false;
  return !/[.*+?^$()[\]{}|\\]/.test(pattern);
}

/**
 * Subsumption check: does rule A's pattern match a superset of what
 * rule B's pattern matches? Returns true only when we can prove it
 * by literal-substring containment. For non-literal patterns we
 * return false (we don't reason about general regex set inclusion).
 *
 * Case-insensitive because the rule engine compiles all patterns
 * with the `i` flag.
 */
export function literalSubsumes(aPattern: string, bPattern: string): boolean {
  if (!isLiteralPattern(aPattern) || !isLiteralPattern(bPattern)) return false;
  return bPattern.toUpperCase().includes(aPattern.toUpperCase());
}

/**
 * Do two rules' amount-range filters overlap?
 *
 * Each rule's range is [min, max], where null on either bound means
 * "no constraint on that side". Ranges overlap iff aMin ≤ bMax AND
 * bMin ≤ aMax (with null bounds treated as ±∞ as appropriate).
 */
export function amountRangesOverlap(a: RuleSpec, b: RuleSpec): boolean {
  const aMin = a.amountMin == null ? null : new Decimal(a.amountMin.toString());
  const aMax = a.amountMax == null ? null : new Decimal(a.amountMax.toString());
  const bMin = b.amountMin == null ? null : new Decimal(b.amountMin.toString());
  const bMax = b.amountMax == null ? null : new Decimal(b.amountMax.toString());

  // A is fully to the left of B? (aMax < bMin)
  if (aMax != null && bMin != null && aMax.lessThan(bMin)) return false;
  // B is fully to the left of A? (bMax < aMin)
  if (bMax != null && aMin != null && bMax.lessThan(aMin)) return false;
  return true;
}

/**
 * Does rule A's amount range CONTAIN rule B's? (B's range fits
 * entirely inside A's.) Used to decide whether A's range subsumes
 * B's for the SHADOWED check.
 */
export function amountRangeContains(a: RuleSpec, b: RuleSpec): boolean {
  const aMin = a.amountMin == null ? null : new Decimal(a.amountMin.toString());
  const aMax = a.amountMax == null ? null : new Decimal(a.amountMax.toString());
  const bMin = b.amountMin == null ? null : new Decimal(b.amountMin.toString());
  const bMax = b.amountMax == null ? null : new Decimal(b.amountMax.toString());

  // A.min must be at or below B.min (or A is open on the left).
  if (aMin != null) {
    if (bMin == null) return false; // B is unbounded left, A isn't
    if (aMin.greaterThan(bMin)) return false;
  }
  // A.max must be at or above B.max (or A is open on the right).
  if (aMax != null) {
    if (bMax == null) return false;
    if (aMax.lessThan(bMax)) return false;
  }
  return true;
}

/**
 * Do two rules' entity scopes overlap? A null entityId means "all
 * entities in the tenant"; a populated one means just that entity.
 *
 * Cases:
 *   - both null → overlap (both apply to everything)
 *   - one null, one populated → overlap (the populated one is a
 *     subset of the null one's scope)
 *   - both populated, same id → overlap
 *   - both populated, different id → NO overlap
 */
export function entityScopesOverlap(a: RuleSpec, b: RuleSpec): boolean {
  const aId = a.entityId ?? null;
  const bId = b.entityId ?? null;
  if (aId == null || bId == null) return true;
  return aId === bId;
}

/**
 * Does rule A's entity scope CONTAIN rule B's?
 *   - A null (all-entities) contains anything
 *   - A populated only contains B if both ids match
 */
export function entityScopeContains(a: RuleSpec, b: RuleSpec): boolean {
  if (a.entityId == null) return true;
  return a.entityId === (b.entityId ?? null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Conflict reporting
// ─────────────────────────────────────────────────────────────────────────────

export type ConflictKind = "SHADOWED" | "OVERLAP" | "DUPLICATE";

export interface RuleConflict {
  kind: ConflictKind;
  /** The higher-priority rule (fires first; matches B's lines too). */
  winnerId: string;
  /** The lower-priority rule (gets shadowed or contested). */
  loserId: string;
  /** Human-readable reason — surfaces directly in the UI. */
  reason: string;
}

/**
 * Detect rule conflicts across an ACTIVE rule list. Returns one
 * RuleConflict per problematic pair. INACTIVE rules are silently
 * skipped — they can't fire so they can't conflict.
 *
 * Algorithm: O(N²) over pairs. Rule libraries in practice stay
 * under a few hundred, so this is fine. If a tenant ever has 10k
 * rules we revisit.
 *
 * Pair ordering: for the SHADOWED/DUPLICATE checks we look at the
 * pair (winner, loser) where winner has the lower priority number
 * (fires first). For OVERLAP both ordering directions are reported
 * once as a single conflict.
 */
export function findRuleConflicts(rules: RuleSpec[]): RuleConflict[] {
  const active = rules.filter((r) => r.isActive);
  const conflicts: RuleConflict[] = [];
  const reportedPairs = new Set<string>();

  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];

      // Pre-screen: no amount overlap or no scope overlap = can't conflict.
      if (!amountRangesOverlap(a, b)) continue;
      if (!entityScopesOverlap(a, b)) continue;

      const pairKey = [a.id, b.id].sort().join("|");
      if (reportedPairs.has(pairKey)) continue;

      // Determine ordering: winner has lower priority number. Ties
      // resolve by name lexicographically (matches the runtime
      // sortRulesByPriority behavior in rules.ts).
      let winner: RuleSpec;
      let loser: RuleSpec;
      if (a.priority < b.priority) {
        winner = a;
        loser = b;
      } else if (a.priority > b.priority) {
        winner = b;
        loser = a;
      } else {
        winner = a.name.localeCompare(b.name) <= 0 ? a : b;
        loser = winner === a ? b : a;
      }

      // ── DUPLICATE ─────────────────────────────────────────────
      // Same pattern + same range + same scope → identical rules.
      // The lower-priority one is dead code.
      if (
        a.descriptionRegex === b.descriptionRegex &&
        amountRangeContains(a, b) &&
        amountRangeContains(b, a) &&
        (a.entityId ?? null) === (b.entityId ?? null)
      ) {
        conflicts.push({
          kind: "DUPLICATE",
          winnerId: winner.id,
          loserId: loser.id,
          reason: `Identical pattern + amount range + scope. "${loser.name}" never fires — "${winner.name}" wins on priority.`,
        });
        reportedPairs.add(pairKey);
        continue;
      }

      // ── SHADOWED ──────────────────────────────────────────────
      // The winner's regex subsumes the loser's, AND winner's amount
      // range contains loser's, AND winner's scope contains loser's.
      // Anything the loser would match, the winner matches too —
      // and fires first because of priority.
      const winnerRegexSubsumesLoser = literalSubsumes(
        winner.descriptionRegex,
        loser.descriptionRegex
      );
      if (
        winnerRegexSubsumesLoser &&
        amountRangeContains(winner, loser) &&
        entityScopeContains(winner, loser)
      ) {
        conflicts.push({
          kind: "SHADOWED",
          winnerId: winner.id,
          loserId: loser.id,
          reason: `"${winner.name}" (priority ${winner.priority}) matches every line "${loser.name}" (priority ${loser.priority}) would — and fires first. Lower the winner's priority, narrow its pattern, or remove the loser.`,
        });
        reportedPairs.add(pairKey);
        continue;
      }

      // ── OVERLAP ───────────────────────────────────────────────
      // Both rules' literal patterns share a literal — neither
      // subsumes the other, but they'll fight over some lines.
      // Lower-priority rule fires only on lines that DON'T match
      // the higher-priority one.
      if (
        isLiteralPattern(a.descriptionRegex) &&
        isLiteralPattern(b.descriptionRegex)
      ) {
        const aUp = a.descriptionRegex.toUpperCase();
        const bUp = b.descriptionRegex.toUpperCase();
        // Patterns share at least one common token (3+ chars) and
        // neither contains the other — partial collision.
        const commonToken = longestCommonSubstring(aUp, bUp);
        if (commonToken.length >= 3 && commonToken !== aUp && commonToken !== bUp) {
          conflicts.push({
            kind: "OVERLAP",
            winnerId: winner.id,
            loserId: loser.id,
            reason: `Patterns share "${commonToken}". Both can match different lines, but lines hitting both go to "${winner.name}" (priority ${winner.priority}). Review whether this is intentional.`,
          });
          reportedPairs.add(pairKey);
        }
      }
    }
  }

  return conflicts;
}

/**
 * Naive longest-common-substring. O(N×M) DP. Fine for short
 * (≤ 200 char) rule patterns. Used only by the OVERLAP heuristic.
 */
function longestCommonSubstring(a: string, b: string): string {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return "";
  let best = 0;
  let bestEnd = 0;
  // 1D rolling array to keep memory bounded.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > best) {
          best = curr[j];
          bestEnd = i;
        }
      } else {
        curr[j] = 0;
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return a.slice(bestEnd - best, bestEnd);
}
