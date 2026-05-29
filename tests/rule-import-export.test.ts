// Rule import/export tests. Pure functions — no DB.
//
// Covers:
//   - buildExportPayload: skips INACTIVE, omits tenant-local
//     metadata, formats Decimal amounts as plain numbers
//   - parseImport: schema validation, ZodError surfacing,
//     per-rule semantic checks (regex compile, amount-range
//     sanity, ADJUST counter-account requirement)
//   - planImport: NEW vs DUPLICATE classification by dedup key,
//     issue passthrough, willCreate flag

import { describe, it, expect } from "vitest";
import {
  buildExportPayload,
  parseImport,
  planImport,
  ImportValidationError,
  RULE_EXPORT_FORMAT_VERSION,
  type RuleExportPayload,
} from "../src/lib/matching/rule-import-export";
import type { RuleSpec } from "../src/lib/matching/rules";

function rule(over: Partial<RuleSpec> = {}): RuleSpec {
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

// ─────────────────────────────────────────────────────────────────────────────
// buildExportPayload
// ─────────────────────────────────────────────────────────────────────────────

describe("buildExportPayload", () => {
  it("includes only ACTIVE rules", () => {
    const p = buildExportPayload({
      rules: [
        rule({ id: "r-1", name: "Active 1", isActive: true }),
        rule({ id: "r-2", name: "Inactive", isActive: false }),
        rule({ id: "r-3", name: "Active 2", isActive: true }),
      ],
    });
    expect(p.rules).toHaveLength(2);
    expect(p.rules.map((r) => r.name)).toEqual(["Active 1", "Active 2"]);
  });

  it("omits tenant-local metadata (id, isActive)", () => {
    const p = buildExportPayload({ rules: [rule({ id: "r-1", name: "X" })] });
    const json = JSON.stringify(p);
    expect(json).not.toContain("\"id\"");
    expect(json).not.toContain("\"isActive\"");
  });

  it("stamps the current format version", () => {
    const p = buildExportPayload({ rules: [rule()] });
    expect(p.formatVersion).toBe(RULE_EXPORT_FORMAT_VERSION);
  });

  it("normalizes Decimal amounts to plain numbers", () => {
    const p = buildExportPayload({
      rules: [
        rule({ amountMin: "100.50" as unknown as null, amountMax: "500.00" as unknown as null }),
      ],
    });
    expect(p.rules[0].amountMin).toBe(100.5);
    expect(p.rules[0].amountMax).toBe(500);
  });

  it("preserves null amounts", () => {
    const p = buildExportPayload({
      rules: [rule({ amountMin: null, amountMax: null })],
    });
    expect(p.rules[0].amountMin).toBe(null);
    expect(p.rules[0].amountMax).toBe(null);
  });

  it("includes exportedAt as ISO timestamp", () => {
    const p = buildExportPayload({
      rules: [rule()],
      nowMs: new Date("2026-05-29T10:00:00Z").getTime(),
    });
    expect(p.exportedAt).toBe("2026-05-29T10:00:00.000Z");
  });

  it("propagates sourceTenantId and notes when set", () => {
    const p = buildExportPayload({
      rules: [rule()],
      sourceTenantId: "tenant-A",
      notes: "Q3 review backup",
    });
    expect(p.sourceTenantId).toBe("tenant-A");
    expect(p.notes).toBe("Q3 review backup");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseImport — happy path
// ─────────────────────────────────────────────────────────────────────────────

function validPayload(over: Partial<RuleExportPayload> = {}): RuleExportPayload {
  return {
    formatVersion: RULE_EXPORT_FORMAT_VERSION,
    exportedAt: "2026-05-29T10:00:00.000Z",
    rules: [
      {
        name: "Stripe payouts",
        descriptionRegex: "STRIPE PAYOUT",
        amountMin: null,
        amountMax: null,
        actionType: "ADJUST",
        counterAccountCode: "1200",
        memoTemplate: null,
        partyCode: "STRIPE",
        priority: 100,
      },
    ],
    ...over,
  };
}

describe("parseImport — happy path", () => {
  it("parses a valid payload from a JSON string", () => {
    const r = parseImport(JSON.stringify(validPayload()));
    expect(r.payload.rules).toHaveLength(1);
    expect(r.perRuleIssues).toEqual([]);
  });

  it("parses a valid payload from an already-parsed object", () => {
    const r = parseImport(validPayload());
    expect(r.payload.rules[0].name).toBe("Stripe payouts");
  });

  it("accepts IGNORE rules without counterAccountCode", () => {
    const r = parseImport(
      validPayload({
        rules: [
          {
            name: "Internal transfers",
            descriptionRegex: "TRANSFER",
            amountMin: null,
            amountMax: null,
            actionType: "IGNORE",
            counterAccountCode: null,
            memoTemplate: null,
            partyCode: null,
            priority: 50,
          },
        ],
      })
    );
    expect(r.perRuleIssues).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseImport — schema rejection
// ─────────────────────────────────────────────────────────────────────────────

describe("parseImport — schema rejection", () => {
  it("rejects malformed JSON", () => {
    expect(() => parseImport("{ not valid json")).toThrow(ImportValidationError);
    expect(() => parseImport("{ not valid json")).toThrow(/Not valid JSON/);
  });

  it("rejects wrong format version", () => {
    expect(() =>
      parseImport({ ...validPayload(), formatVersion: 99 })
    ).toThrow(/formatVersion/);
  });

  it("rejects missing rules array", () => {
    expect(() =>
      parseImport({
        formatVersion: RULE_EXPORT_FORMAT_VERSION,
        exportedAt: "2026-05-29T10:00:00Z",
        // rules: missing
      })
    ).toThrow(/rules/);
  });

  it("rejects invalid actionType", () => {
    expect(() =>
      parseImport(
        validPayload({
          rules: [
            { ...validPayload().rules[0], actionType: "INVALID" as never },
          ],
        })
      )
    ).toThrow(/actionType/);
  });

  it("rejects priority out of range", () => {
    expect(() =>
      parseImport(
        validPayload({
          rules: [{ ...validPayload().rules[0], priority: 0 }],
        })
      )
    ).toThrow(/priority/);
  });

  it("rejects name over 200 chars", () => {
    expect(() =>
      parseImport(
        validPayload({
          rules: [{ ...validPayload().rules[0], name: "x".repeat(201) }],
        })
      )
    ).toThrow(/name/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseImport — per-rule semantic issues
// ─────────────────────────────────────────────────────────────────────────────

describe("parseImport — per-rule issues", () => {
  it("flags ADJUST rule with no counterAccountCode", () => {
    const r = parseImport(
      validPayload({
        rules: [
          {
            ...validPayload().rules[0],
            actionType: "ADJUST",
            counterAccountCode: "",
          },
        ],
      })
    );
    expect(r.perRuleIssues).toHaveLength(1);
    expect(r.perRuleIssues[0].reason).toContain("counterAccountCode");
  });

  it("flags amountMin > amountMax", () => {
    const r = parseImport(
      validPayload({
        rules: [
          {
            ...validPayload().rules[0],
            amountMin: 500,
            amountMax: 100,
          },
        ],
      })
    );
    expect(r.perRuleIssues).toHaveLength(1);
    expect(r.perRuleIssues[0].reason).toContain("amountMin");
  });

  it("flags rules with regex that fails the rules.ts compile policy", () => {
    const r = parseImport(
      validPayload({
        rules: [
          {
            ...validPayload().rules[0],
            descriptionRegex: "(a+)+", // catastrophic backtracking
          },
        ],
      })
    );
    expect(r.perRuleIssues).toHaveLength(1);
    expect(r.perRuleIssues[0].reason).toContain("nested unbounded");
  });

  it("flags multiple issues across different rules", () => {
    const r = parseImport(
      validPayload({
        rules: [
          { ...validPayload().rules[0], counterAccountCode: "" }, // ADJUST issue
          { ...validPayload().rules[0], amountMin: 99, amountMax: 1 }, // range issue
          validPayload().rules[0], // OK
        ],
      })
    );
    expect(r.perRuleIssues).toHaveLength(2);
    expect(r.perRuleIssues[0].index).toBe(0);
    expect(r.perRuleIssues[1].index).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// planImport — NEW vs DUPLICATE
// ─────────────────────────────────────────────────────────────────────────────

describe("planImport — dedup classification", () => {
  it("classifies entry as NEW when nothing matches in the target tenant", () => {
    const parsed = parseImport(validPayload());
    const plan = planImport({ parsed, existing: [] });
    expect(plan.newCount).toBe(1);
    expect(plan.duplicateCount).toBe(0);
    expect(plan.entries[0].willCreate).toBe(true);
  });

  it("classifies entry as DUPLICATE when same name+regex+amounts+action exist", () => {
    const parsed = parseImport(validPayload());
    const plan = planImport({
      parsed,
      existing: [
        {
          id: "existing-1",
          name: "Stripe payouts",
          descriptionRegex: "STRIPE PAYOUT",
          amountMin: null,
          amountMax: null,
          actionType: "ADJUST",
        },
      ],
    });
    expect(plan.duplicateCount).toBe(1);
    expect(plan.entries[0].willCreate).toBe(false);
    expect(plan.entries[0].duplicateOfId).toBe("existing-1");
  });

  it("treats different actionType as NEW (not a duplicate)", () => {
    const parsed = parseImport(validPayload());
    const plan = planImport({
      parsed,
      existing: [
        {
          id: "existing-1",
          name: "Stripe payouts",
          descriptionRegex: "STRIPE PAYOUT",
          amountMin: null,
          amountMax: null,
          actionType: "IGNORE", // different
        },
      ],
    });
    expect(plan.newCount).toBe(1);
    expect(plan.duplicateCount).toBe(0);
  });

  it("treats different amount range as NEW", () => {
    const parsed = parseImport(
      validPayload({
        rules: [{ ...validPayload().rules[0], amountMin: 100 }],
      })
    );
    const plan = planImport({
      parsed,
      existing: [
        {
          id: "existing-1",
          name: "Stripe payouts",
          descriptionRegex: "STRIPE PAYOUT",
          amountMin: null,
          amountMax: null,
          actionType: "ADJUST",
        },
      ],
    });
    expect(plan.newCount).toBe(1);
  });

  it("normalizes name (case-insensitive + trim) for dedup", () => {
    const parsed = parseImport(
      validPayload({
        rules: [{ ...validPayload().rules[0], name: "  STRIPE PAYOUTS  " }],
      })
    );
    const plan = planImport({
      parsed,
      existing: [
        {
          id: "existing-1",
          name: "stripe payouts",
          descriptionRegex: "STRIPE PAYOUT",
          amountMin: null,
          amountMax: null,
          actionType: "ADJUST",
        },
      ],
    });
    expect(plan.duplicateCount).toBe(1);
  });

  it("entries with issues are not created and not counted as duplicate", () => {
    const parsed = parseImport(
      validPayload({
        rules: [
          {
            ...validPayload().rules[0],
            descriptionRegex: "(a+)+", // bad regex
          },
        ],
      })
    );
    const plan = planImport({ parsed, existing: [] });
    expect(plan.entries[0].willCreate).toBe(false);
    expect(plan.entries[0].issue).toBeDefined();
    expect(plan.issueCount).toBe(1);
    expect(plan.newCount).toBe(0);
    expect(plan.duplicateCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip: export then re-import
// ─────────────────────────────────────────────────────────────────────────────

describe("export → JSON.stringify → parseImport → planImport round trip", () => {
  it("round trips a typical rule library", () => {
    const original = [
      rule({ id: "r-1", name: "Stripe payouts", descriptionRegex: "STRIPE", priority: 50 }),
      rule({
        id: "r-2",
        name: "ATM ignore",
        descriptionRegex: "ATM WITHDRAWAL",
        actionType: "IGNORE",
        counterAccountCode: null,
        priority: 75,
      }),
    ];
    const exported = buildExportPayload({ rules: original });
    const parsed = parseImport(JSON.stringify(exported));
    expect(parsed.perRuleIssues).toEqual([]);
    expect(parsed.payload.rules).toHaveLength(2);

    // Importing into a fresh tenant: all NEW.
    const planFresh = planImport({ parsed, existing: [] });
    expect(planFresh.newCount).toBe(2);

    // Importing into a tenant that already has the same rules: all
    // DUPLICATE.
    const planSelf = planImport({
      parsed,
      existing: original.map((r) => ({
        id: r.id,
        name: r.name,
        descriptionRegex: r.descriptionRegex,
        amountMin: r.amountMin,
        amountMax: r.amountMax,
        actionType: r.actionType,
      })),
    });
    expect(planSelf.duplicateCount).toBe(2);
    expect(planSelf.newCount).toBe(0);
  });
});
