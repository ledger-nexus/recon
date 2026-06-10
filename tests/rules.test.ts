// MatchingRule evaluator tests. Pure functions — no DB.
//
// Covers:
//   - regex compilation: valid patterns compile, invalid throw,
//     ReDoS-prone patterns rejected, length cap enforced
//   - line matching: description regex, amount filters (min/max/both),
//     entity scope filter
//   - priority + ordering: lower number wins, ties broken by name
//   - first-match-wins across a rule list
//   - memo template rendering

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  compileRuleRegex,
  compileRules,
  ruleMatchesLine,
  sortRulesByPriority,
  findMatchingRule,
  renderRuleMemo,
  evaluateRulesAcrossLines,
  RuleCompileError,
  type RuleSpec,
  type CompiledRule,
  type BankLineForRules,
} from "../src/lib/matching/rules";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function spec(over: Partial<RuleSpec> = {}): RuleSpec {
  return {
    id: over.id ?? "rule-1",
    name: over.name ?? "Test rule",
    descriptionRegex: over.descriptionRegex ?? "STRIPE",
    amountMin: over.amountMin ?? null,
    amountMax: over.amountMax ?? null,
    priority: over.priority ?? 100,
    isActive: over.isActive ?? true,
    actionType: over.actionType ?? "ADJUST",
    counterAccountCode: over.counterAccountCode ?? "1200",
    memoTemplate: over.memoTemplate ?? null,
    partyCode: over.partyCode ?? null,
    entityId: over.entityId ?? null,
  };
}

function line(over: Partial<BankLineForRules> = {}): BankLineForRules {
  return {
    id: over.id ?? "line-1",
    description: over.description ?? "STRIPE PAYOUT 12345",
    amount: over.amount ?? 1500.0,
    transactionDate: over.transactionDate ?? new Date("2026-04-15"),
    entityId: over.entityId ?? null,
  };
}

function compile(s: RuleSpec): CompiledRule {
  return { spec: s, regex: compileRuleRegex(s.descriptionRegex) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Regex compilation
// ─────────────────────────────────────────────────────────────────────────────

describe("compileRuleRegex", () => {
  it("compiles a simple pattern case-insensitively", () => {
    const r = compileRuleRegex("STRIPE");
    expect(r.test("stripe payout")).toBe(true);
    expect(r.test("STRIPE PAYOUT")).toBe(true);
    expect(r.test("plaid transfer")).toBe(false);
  });

  it("supports anchors and character classes", () => {
    const r = compileRuleRegex("^ZELLE FROM \\w+$");
    expect(r.test("ZELLE FROM JOHN")).toBe(true);
    expect(r.test("zelle from jane")).toBe(true);
    expect(r.test("FAILED ZELLE FROM JOHN")).toBe(false);
  });

  it("rejects an empty pattern", () => {
    expect(() => compileRuleRegex("")).toThrow(RuleCompileError);
  });

  it("rejects patterns over the length cap", () => {
    const longPattern = "a".repeat(201);
    expect(() => compileRuleRegex(longPattern)).toThrow(/longer than/);
  });

  it("rejects nested unbounded quantifiers (ReDoS shape)", () => {
    expect(() => compileRuleRegex("(a+)+")).toThrow(/nested unbounded quantifiers/);
    expect(() => compileRuleRegex("(.*)*")).toThrow(/nested unbounded quantifiers/);
    expect(() => compileRuleRegex("(a|b+)*")).toThrow(/nested unbounded quantifiers/);
  });

  it("allows non-nested quantifiers", () => {
    expect(() => compileRuleRegex("STRIPE.*PAYOUT")).not.toThrow();
    expect(() => compileRuleRegex("[A-Z]+\\d+")).not.toThrow();
  });

  it("rejects invalid regex syntax", () => {
    expect(() => compileRuleRegex("[unclosed")).toThrow(/Invalid regex/);
    expect(() => compileRuleRegex("(unclosed")).toThrow(/Invalid regex/);
  });
});

describe("compileRules", () => {
  it("compiles only active rules", () => {
    const rules = compileRules([
      spec({ id: "r-1", isActive: true }),
      spec({ id: "r-2", isActive: false }),
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].spec.id).toBe("r-1");
  });

  it("throws on the first bad rule (operator sees the offender)", () => {
    expect(() =>
      compileRules([spec({ id: "r-1" }), spec({ id: "r-2", descriptionRegex: "(a+)+" })])
    ).toThrow(RuleCompileError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ruleMatchesLine
// ─────────────────────────────────────────────────────────────────────────────

describe("ruleMatchesLine — description regex", () => {
  it("matches when the regex hits the description", () => {
    const r = compile(spec({ descriptionRegex: "STRIPE PAYOUT" }));
    expect(ruleMatchesLine(r, line({ description: "STRIPE PAYOUT abc" }))).toBe(true);
  });

  it("doesn't match when the regex misses", () => {
    const r = compile(spec({ descriptionRegex: "STRIPE PAYOUT" }));
    expect(ruleMatchesLine(r, line({ description: "Plaid transfer" }))).toBe(false);
  });
});

describe("ruleMatchesLine — amount filters", () => {
  it("matches when amount >= amountMin", () => {
    const r = compile(spec({ amountMin: 1000 }));
    expect(ruleMatchesLine(r, line({ amount: 1500 }))).toBe(true);
    expect(ruleMatchesLine(r, line({ amount: 999 }))).toBe(false);
    expect(ruleMatchesLine(r, line({ amount: 1000 }))).toBe(true);
  });

  it("matches when amount <= amountMax", () => {
    const r = compile(spec({ amountMax: 50 }));
    expect(ruleMatchesLine(r, line({ amount: 25 }))).toBe(true);
    expect(ruleMatchesLine(r, line({ amount: 50 }))).toBe(true);
    expect(ruleMatchesLine(r, line({ amount: 51 }))).toBe(false);
  });

  it("matches when amount is in [min, max]", () => {
    const r = compile(spec({ amountMin: 100, amountMax: 200 }));
    expect(ruleMatchesLine(r, line({ amount: 150 }))).toBe(true);
    expect(ruleMatchesLine(r, line({ amount: 99 }))).toBe(false);
    expect(ruleMatchesLine(r, line({ amount: 201 }))).toBe(false);
  });

  it("respects sign — negative withdrawals are < 0", () => {
    // "Bank fees between $5 and $50" = amount between -50 and -5
    const r = compile(spec({ amountMin: -50, amountMax: -5 }));
    expect(ruleMatchesLine(r, line({ amount: -25 }))).toBe(true);
    expect(ruleMatchesLine(r, line({ amount: 25 }))).toBe(false);
    expect(ruleMatchesLine(r, line({ amount: -75 }))).toBe(false);
  });

  it("matches Decimal amounts", () => {
    const r = compile(spec({ amountMin: new Decimal("100.50") }));
    expect(ruleMatchesLine(r, line({ amount: new Decimal("100.50") }))).toBe(true);
    expect(ruleMatchesLine(r, line({ amount: new Decimal("100.49") }))).toBe(false);
  });
});

describe("ruleMatchesLine — entity scope", () => {
  it("contract-wide rule (entityId=null) matches lines of any entity", () => {
    const r = compile(spec({ entityId: null }));
    expect(ruleMatchesLine(r, line({ entityId: "ent-1" }))).toBe(true);
    expect(ruleMatchesLine(r, line({ entityId: "ent-2" }))).toBe(true);
  });

  it("entity-scoped rule only matches its entity's lines", () => {
    const r = compile(spec({ entityId: "ent-1" }));
    expect(ruleMatchesLine(r, line({ entityId: "ent-1" }))).toBe(true);
    expect(ruleMatchesLine(r, line({ entityId: "ent-2" }))).toBe(false);
  });

  it("entity-scoped rule matches when line has no entity (legacy / unknown — defensive)", () => {
    const r = compile(spec({ entityId: "ent-1" }));
    expect(ruleMatchesLine(r, line({ entityId: null }))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Priority + first-match-wins
// ─────────────────────────────────────────────────────────────────────────────

describe("sortRulesByPriority", () => {
  it("sorts ascending — lower number first", () => {
    const rs = [
      compile(spec({ id: "r-3", priority: 30 })),
      compile(spec({ id: "r-1", priority: 10 })),
      compile(spec({ id: "r-2", priority: 20 })),
    ];
    const sorted = sortRulesByPriority(rs);
    expect(sorted.map((r) => r.spec.id)).toEqual(["r-1", "r-2", "r-3"]);
  });

  it("breaks ties lexicographically by name", () => {
    const rs = [
      compile(spec({ id: "r-b", priority: 10, name: "Bravo" })),
      compile(spec({ id: "r-a", priority: 10, name: "Alpha" })),
      compile(spec({ id: "r-c", priority: 10, name: "Charlie" })),
    ];
    const sorted = sortRulesByPriority(rs);
    expect(sorted.map((r) => r.spec.id)).toEqual(["r-a", "r-b", "r-c"]);
  });
});

describe("findMatchingRule — first match wins", () => {
  it("returns the first rule (by priority order) that matches", () => {
    const rs = sortRulesByPriority([
      compile(spec({ id: "specific", priority: 10, descriptionRegex: "STRIPE PAYOUT NY" })),
      compile(spec({ id: "general", priority: 50, descriptionRegex: "STRIPE PAYOUT" })),
    ]);
    const r = findMatchingRule(rs, line({ description: "STRIPE PAYOUT NY 12345" }));
    expect(r?.spec.id).toBe("specific");
  });

  it("falls through to the next when the first doesn't match", () => {
    const rs = sortRulesByPriority([
      compile(spec({ id: "specific", priority: 10, descriptionRegex: "STRIPE PAYOUT NY" })),
      compile(spec({ id: "general", priority: 50, descriptionRegex: "STRIPE PAYOUT" })),
    ]);
    const r = findMatchingRule(rs, line({ description: "STRIPE PAYOUT TX 12345" }));
    expect(r?.spec.id).toBe("general");
  });

  it("returns null when no rule claims the line", () => {
    const rs = sortRulesByPriority([
      compile(spec({ descriptionRegex: "STRIPE" })),
      compile(spec({ descriptionRegex: "PAYPAL" })),
    ]);
    expect(findMatchingRule(rs, line({ description: "Plaid sync" }))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Memo template rendering
// ─────────────────────────────────────────────────────────────────────────────

describe("renderRuleMemo", () => {
  it("falls back to a default when no template is set", () => {
    const r = compile(spec({ memoTemplate: null, name: "Stripe payouts" }));
    expect(renderRuleMemo(r, line())).toBe("Auto-classified via rule 'Stripe payouts'");
  });

  it("substitutes {description}, {date}, {ruleName}", () => {
    const r = compile(
      spec({
        memoTemplate: "{ruleName}: {description} on {date}",
        name: "Stripe payouts",
      })
    );
    const result = renderRuleMemo(
      r,
      line({
        description: "  STRIPE PAYOUT NY  ",
        transactionDate: new Date("2026-04-15T00:00:00Z"),
      })
    );
    expect(result).toBe("Stripe payouts: STRIPE PAYOUT NY on 2026-04-15");
  });

  it("replaces all occurrences of a token", () => {
    const r = compile(
      spec({ memoTemplate: "{ruleName} {ruleName}", name: "X" })
    );
    expect(renderRuleMemo(r, line())).toBe("X X");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateRulesAcrossLines
// ─────────────────────────────────────────────────────────────────────────────

describe("evaluateRulesAcrossLines", () => {
  it("returns one decision per input line, preserving order", () => {
    const rs = compileRules([
      spec({ id: "stripe", priority: 10, descriptionRegex: "STRIPE" }),
      spec({ id: "atm", priority: 10, descriptionRegex: "ATM", actionType: "IGNORE" }),
    ]);
    const lines = [
      line({ id: "a", description: "STRIPE PAYOUT 1" }),
      line({ id: "b", description: "ATM WITHDRAWAL" }),
      line({ id: "c", description: "Other transaction" }),
    ];
    const decisions = evaluateRulesAcrossLines(rs, lines);
    expect(decisions).toHaveLength(3);
    expect(decisions[0].rule?.spec.id).toBe("stripe");
    expect(decisions[1].rule?.spec.id).toBe("atm");
    expect(decisions[2].rule).toBeNull();
  });

  it("only ACTIVE rules participate", () => {
    const rs = compileRules([
      spec({ id: "active", isActive: true, descriptionRegex: "X" }),
      spec({ id: "inactive", isActive: false, descriptionRegex: "X" }),
    ]);
    expect(rs).toHaveLength(1);
    const decisions = evaluateRulesAcrossLines(rs, [line({ description: "X" })]);
    expect(decisions[0].rule?.spec.id).toBe("active");
  });
});
