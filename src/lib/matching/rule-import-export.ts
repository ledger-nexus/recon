// Rule library import/export. Pure functions, no DB.
//
// CPAs running monthly closes for many client firms accumulate a
// library of "I know what this is" matching rules over time. The
// library is one of their most valuable assets — months of curation
// distilled into a set of regex + amount + counter-account patterns.
//
// This module gives them three operations on that library:
//
//   1. Export: turn the active rule set into a portable JSON
//      payload. Used for backups, sharing across tenants the
//      operator administers, or carrying patterns to a new firm.
//   2. Validate: zod-parse an incoming JSON payload, surface
//      schema errors with row-level context.
//   3. Dedup: given a parsed import and the existing rules in the
//      target tenant, classify each incoming rule as NEW or
//      DUPLICATE so the import action can skip duplicates without
//      bothering the operator.
//
// What's deliberately NOT in the export:
//
//   - applicationCount, lastAppliedAt — tenant-local history; meaningless
//     in another tenant
//   - createdBy, createdAt, updatedAt — operator/timestamp metadata
//   - id, tenantId — re-generated on import
//   - entityId — entity scope is tenant-local; the importer chooses
//     whether to preserve or clear (we clear by default)

import { z } from "zod";
import { compileRuleRegex, RuleCompileError, type RuleSpec } from "./rules";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const RULE_EXPORT_FORMAT_VERSION = 1;

const RuleExportEntrySchema = z.object({
  name: z.string().min(1).max(200),
  descriptionRegex: z.string().min(1).max(200),
  amountMin: z.number().nullable().optional(),
  amountMax: z.number().nullable().optional(),
  actionType: z.enum(["IGNORE", "ADJUST"]),
  counterAccountCode: z.string().nullable().optional(),
  memoTemplate: z.string().nullable().optional(),
  partyCode: z.string().nullable().optional(),
  priority: z.number().int().min(1).max(10_000),
});

export const RuleExportPayloadSchema = z.object({
  /** Format version — bump when breaking changes hit the schema. */
  formatVersion: z.literal(RULE_EXPORT_FORMAT_VERSION),
  /** ISO timestamp of the export. Informational; the importer doesn't act on it. */
  exportedAt: z.string(),
  /** Tenant id the rules came from — informational only. The importer always uses the CURRENT tenant. */
  sourceTenantId: z.string().optional(),
  /** Free-form notes the operator can attach. */
  notes: z.string().max(2000).optional(),
  rules: z.array(RuleExportEntrySchema),
});

export type RuleExportEntry = z.infer<typeof RuleExportEntrySchema>;
export type RuleExportPayload = z.infer<typeof RuleExportPayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the export payload from a list of rule specs (typically the
 * tenant's ACTIVE rules). The payload omits tenant-local metadata
 * (applicationCount, createdBy, etc.) so it ports cleanly to other
 * tenants. Inactive rules are excluded — they don't fire and shouldn't
 * be propagated.
 */
export function buildExportPayload(input: {
  rules: RuleSpec[];
  sourceTenantId?: string;
  notes?: string;
  /** Test seam. */
  nowMs?: number;
}): RuleExportPayload {
  const exportedAt = new Date(input.nowMs ?? Date.now()).toISOString();
  return {
    formatVersion: RULE_EXPORT_FORMAT_VERSION,
    exportedAt,
    sourceTenantId: input.sourceTenantId,
    notes: input.notes,
    rules: input.rules
      .filter((r) => r.isActive)
      .map((r) => ({
        name: r.name,
        descriptionRegex: r.descriptionRegex,
        amountMin:
          r.amountMin == null
            ? null
            : typeof r.amountMin === "number"
              ? r.amountMin
              : Number(r.amountMin.toString()),
        amountMax:
          r.amountMax == null
            ? null
            : typeof r.amountMax === "number"
              ? r.amountMax
              : Number(r.amountMax.toString()),
        actionType: r.actionType,
        counterAccountCode: r.counterAccountCode,
        memoTemplate: r.memoTemplate,
        partyCode: r.partyCode,
        priority: r.priority,
      })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}

export interface ParsedImport {
  payload: RuleExportPayload;
  /** Per-rule validation issues — non-fatal regex errors etc. */
  perRuleIssues: Array<{ index: number; name: string; reason: string }>;
}

/**
 * Parse + validate a JSON string (or already-parsed object) as a
 * rule export payload. Throws ImportValidationError on structural
 * failure (malformed JSON, missing fields, wrong types). Returns
 * a result that includes any per-rule issues (e.g., regex compile
 * errors) so the operator can see exactly which rules will be
 * skipped without aborting the whole import.
 */
export function parseImport(raw: string | unknown): ParsedImport {
  let json: unknown;
  if (typeof raw === "string") {
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new ImportValidationError(
        `Not valid JSON: ${e instanceof Error ? e.message : "parse error"}`
      );
    }
  } else {
    json = raw;
  }

  let payload: RuleExportPayload;
  try {
    payload = RuleExportPayloadSchema.parse(json);
  } catch (e) {
    if (e instanceof z.ZodError) {
      const first = e.issues[0];
      const path = first.path.join(".");
      throw new ImportValidationError(
        `Schema error at "${path}": ${first.message}`
      );
    }
    throw new ImportValidationError(
      `Schema parse failed: ${e instanceof Error ? e.message : "unknown"}`
    );
  }

  // Per-rule semantic checks. We don't abort on these — we surface
  // them so the operator can decide whether to import the others.
  const perRuleIssues: ParsedImport["perRuleIssues"] = [];
  payload.rules.forEach((rule, i) => {
    // ADJUST rules must carry a counterAccountCode.
    if (rule.actionType === "ADJUST" && !rule.counterAccountCode?.trim()) {
      perRuleIssues.push({
        index: i,
        name: rule.name,
        reason: "ADJUST action requires counterAccountCode",
      });
      return;
    }
    // amountMin > amountMax is structurally fine for Zod but
    // semantically broken.
    if (
      rule.amountMin != null &&
      rule.amountMax != null &&
      rule.amountMin > rule.amountMax
    ) {
      perRuleIssues.push({
        index: i,
        name: rule.name,
        reason: `amountMin (${rule.amountMin}) > amountMax (${rule.amountMax})`,
      });
      return;
    }
    // Regex must compile under our existing rules.ts policy
    // (length cap, no nested unbounded quantifiers).
    try {
      compileRuleRegex(rule.descriptionRegex);
    } catch (e) {
      if (e instanceof RuleCompileError) {
        perRuleIssues.push({ index: i, name: rule.name, reason: e.message });
      } else {
        throw e;
      }
    }
  });

  return { payload, perRuleIssues };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dedup
// ─────────────────────────────────────────────────────────────────────────────

export type ImportDisposition = "NEW" | "DUPLICATE";

export interface ImportPlan {
  entries: Array<{
    index: number;
    entry: RuleExportEntry;
    disposition: ImportDisposition;
    duplicateOfId?: string;
    duplicateOfName?: string;
    /** When false, this entry will be skipped on commit (issue or duplicate). */
    willCreate: boolean;
    issue?: string;
  }>;
  newCount: number;
  duplicateCount: number;
  issueCount: number;
}

/**
 * Classify each incoming rule as NEW or DUPLICATE relative to the
 * tenant's existing rules. The dedup key is
 * (name, descriptionRegex, amountMin, amountMax, actionType) — when
 * all five match, we consider the incoming rule a duplicate and
 * skip it. The operator who actively wants to overwrite can
 * deactivate or rename the existing rule first.
 */
export function planImport(input: {
  parsed: ParsedImport;
  existing: Array<
    Pick<RuleSpec, "id" | "name" | "descriptionRegex" | "amountMin" | "amountMax" | "actionType">
  >;
}): ImportPlan {
  const issueByIndex = new Map<number, string>();
  for (const issue of input.parsed.perRuleIssues) {
    issueByIndex.set(issue.index, issue.reason);
  }

  // Index existing rules by the dedup key so the per-rule comparison
  // is O(1).
  const existingByKey = new Map<
    string,
    { id: string; name: string }
  >();
  for (const r of input.existing) {
    const key = makeDedupKey({
      name: r.name,
      descriptionRegex: r.descriptionRegex,
      amountMin:
        r.amountMin == null
          ? null
          : typeof r.amountMin === "number"
            ? r.amountMin
            : Number(r.amountMin.toString()),
      amountMax:
        r.amountMax == null
          ? null
          : typeof r.amountMax === "number"
            ? r.amountMax
            : Number(r.amountMax.toString()),
      actionType: r.actionType,
    });
    existingByKey.set(key, { id: r.id, name: r.name });
  }

  const entries: ImportPlan["entries"] = [];
  let newCount = 0;
  let duplicateCount = 0;
  let issueCount = 0;

  input.parsed.payload.rules.forEach((entry, index) => {
    const issue = issueByIndex.get(index);
    if (issue) {
      entries.push({
        index,
        entry,
        disposition: "NEW",
        willCreate: false,
        issue,
      });
      issueCount += 1;
      return;
    }
    const key = makeDedupKey({
      name: entry.name,
      descriptionRegex: entry.descriptionRegex,
      amountMin: entry.amountMin ?? null,
      amountMax: entry.amountMax ?? null,
      actionType: entry.actionType,
    });
    const existing = existingByKey.get(key);
    if (existing) {
      entries.push({
        index,
        entry,
        disposition: "DUPLICATE",
        duplicateOfId: existing.id,
        duplicateOfName: existing.name,
        willCreate: false,
      });
      duplicateCount += 1;
    } else {
      entries.push({
        index,
        entry,
        disposition: "NEW",
        willCreate: true,
      });
      newCount += 1;
    }
  });

  return { entries, newCount, duplicateCount, issueCount };
}

function makeDedupKey(input: {
  name: string;
  descriptionRegex: string;
  amountMin: number | null;
  amountMax: number | null;
  actionType: "IGNORE" | "ADJUST";
}): string {
  // Trim + case-fold name to catch operator typos that shouldn't
  // count as new rules.
  const name = input.name.trim().toLowerCase();
  const regex = input.descriptionRegex; // keep case-sensitive — semantic
  const min = input.amountMin == null ? "null" : input.amountMin.toString();
  const max = input.amountMax == null ? "null" : input.amountMax.toString();
  return `${name} ${regex} ${min} ${max} ${input.actionType}`;
}
