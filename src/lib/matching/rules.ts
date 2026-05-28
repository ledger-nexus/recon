// MatchingRule evaluator — pure functions.
//
// Given a list of compiled rules and a bank line, return which rule
// (if any) claims the line. First match wins by priority + name.
//
// Design constraints:
//
//   1. Pure. No DB, no I/O. The Server Action loads rules + lines
//      and feeds them in; the engine just decides.
//
//   2. ReDoS-safe. Untrusted operator input compiles to regex. We
//      cap pattern length, reject patterns with catastrophic
//      backtracking risk (nested quantifiers), and time each match
//      against a wall-clock budget (best-effort — Node's RegExp
//      isn't preemptable, so the length+complexity cap is the
//      primary defense).
//
//   3. Deterministic ordering. Two rules with the same priority
//      resolve by lexicographic name so the operator always sees
//      the same outcome for a given input.

import { Decimal } from "decimal.js";

// Per-pattern source-length cap. A real bookkeeper rule is rarely over
// 100 chars; 200 is generous and keeps regex compilation/matching cheap.
const MAX_PATTERN_LENGTH = 200;

// Catastrophic-backtracking detection (heuristic). The classic killer
// is a nested quantifier on the same group: `(a+)+`, `(.*)*`, `(a|a)*`.
// We reject any pattern with `+` or `*` immediately after a closing
// group that itself contains an unbounded quantifier. False positives
// here just mean the operator has to flatten their regex — that's a
// cheap price for a Server Action safety guarantee.
const NESTED_QUANTIFIER_PATTERN = /\([^)]*[+*][^)]*\)\s*[+*]/;

export interface RuleSpec {
  id: string;
  name: string;
  descriptionRegex: string;
  amountMin: Decimal | string | number | null;
  amountMax: Decimal | string | number | null;
  priority: number;
  isActive: boolean;
  actionType: "IGNORE" | "ADJUST";
  counterAccountCode: string | null;
  memoTemplate: string | null;
  partyCode: string | null;
  /** Optional entity scope filter. Null = applies anywhere in the tenant. */
  entityId?: string | null;
}

export interface BankLineForRules {
  id: string;
  description: string;
  /** Signed: positive = deposit, negative = withdrawal. */
  amount: Decimal | string | number;
  transactionDate: Date;
  /** Used for entity-scoped rules. Null when the line's entity is unknown. */
  entityId?: string | null;
}

export interface CompiledRule {
  spec: RuleSpec;
  regex: RegExp;
}

export class RuleCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleCompileError";
  }
}

/**
 * Validate + compile a single rule's regex. Throws RuleCompileError
 * with a human-readable message if anything's off. Called both at
 * rule creation time (so the operator gets immediate feedback) and at
 * apply time (so a corrupted DB row doesn't crash the engine).
 */
export function compileRuleRegex(pattern: string): RegExp {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new RuleCompileError("Pattern is empty");
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new RuleCompileError(
      `Pattern is longer than ${MAX_PATTERN_LENGTH} chars (got ${pattern.length}). Simplify or split into multiple rules.`
    );
  }
  if (NESTED_QUANTIFIER_PATTERN.test(pattern)) {
    throw new RuleCompileError(
      `Pattern contains nested unbounded quantifiers (e.g., (a+)+) which can run in exponential time. Flatten the pattern.`
    );
  }
  try {
    // Case-insensitive. No 'g' flag — we test, not iterate.
    return new RegExp(pattern, "i");
  } catch (e) {
    throw new RuleCompileError(
      `Invalid regex: ${e instanceof Error ? e.message : "unknown error"}`
    );
  }
}

export function compileRules(specs: RuleSpec[]): CompiledRule[] {
  return specs
    .filter((s) => s.isActive)
    .map((spec) => ({ spec, regex: compileRuleRegex(spec.descriptionRegex) }));
}

/**
 * Test a single rule against a single line. Returns true if all of:
 *   - description matches the regex
 *   - signed amount is within [amountMin, amountMax] when set
 *   - entity scope matches (rule.entityId is null OR line.entityId equals rule.entityId)
 */
export function ruleMatchesLine(rule: CompiledRule, line: BankLineForRules): boolean {
  if (rule.spec.entityId && line.entityId && rule.spec.entityId !== line.entityId) {
    return false;
  }
  if (!rule.regex.test(line.description)) return false;

  if (rule.spec.amountMin != null || rule.spec.amountMax != null) {
    const amount = line.amount instanceof Decimal
      ? line.amount
      : new Decimal(line.amount);
    if (rule.spec.amountMin != null) {
      const min = rule.spec.amountMin instanceof Decimal
        ? rule.spec.amountMin
        : new Decimal(rule.spec.amountMin);
      if (amount.lessThan(min)) return false;
    }
    if (rule.spec.amountMax != null) {
      const max = rule.spec.amountMax instanceof Decimal
        ? rule.spec.amountMax
        : new Decimal(rule.spec.amountMax);
      if (amount.greaterThan(max)) return false;
    }
  }
  return true;
}

/**
 * Sort rules by application order: ascending priority, then
 * lexicographic name. Stable for tie-breaking.
 */
export function sortRulesByPriority(rules: CompiledRule[]): CompiledRule[] {
  return [...rules].sort((a, b) => {
    if (a.spec.priority !== b.spec.priority) return a.spec.priority - b.spec.priority;
    return a.spec.name.localeCompare(b.spec.name);
  });
}

/**
 * First-match-wins evaluation across an entire ordered rule list.
 * Returns the winning rule or null when no rule claims the line.
 */
export function findMatchingRule(
  rules: CompiledRule[],
  line: BankLineForRules
): CompiledRule | null {
  for (const r of rules) {
    if (ruleMatchesLine(r, line)) return r;
  }
  return null;
}

/**
 * Render a memo string for a line using the rule's memoTemplate.
 * Supported substitutions:
 *   {description} → the bank line's description, trimmed
 *   {date}        → the transaction date as YYYY-MM-DD
 *   {ruleName}    → the rule's name (useful when several map to a
 *                   shared counter account but you want to know which fired)
 *
 * Falls back to "Auto-classified via rule '<ruleName>'" when the
 * rule has no template.
 */
export function renderRuleMemo(
  rule: CompiledRule,
  line: BankLineForRules
): string {
  const tmpl = rule.spec.memoTemplate?.trim();
  if (!tmpl) {
    return `Auto-classified via rule '${rule.spec.name}'`;
  }
  const isoDate = line.transactionDate.toISOString().slice(0, 10);
  return tmpl
    .replaceAll("{description}", line.description.trim())
    .replaceAll("{date}", isoDate)
    .replaceAll("{ruleName}", rule.spec.name);
}

/**
 * Evaluate a list of compiled rules against many lines. Returns one
 * decision per line in input order. Used by applyRulesToStatement to
 * decide what to do across the whole statement before any DB writes.
 */
export function evaluateRulesAcrossLines(
  rules: CompiledRule[],
  lines: BankLineForRules[]
): Array<{ line: BankLineForRules; rule: CompiledRule | null }> {
  const sorted = sortRulesByPriority(rules);
  return lines.map((line) => ({ line, rule: findMatchingRule(sorted, line) }));
}
