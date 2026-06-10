"use server";

// Server Actions for matching-rule import/export.
//
//   exportMatchingRulesAction — fetches the tenant's ACTIVE rules,
//     builds the export payload via the pure module, returns it as
//     a JSON-serializable object the client can persist to a file.
//
//   previewImportAction — takes raw JSON, parses + classifies
//     against the tenant's existing rules, returns an ImportPlan
//     the operator reviews BEFORE committing. Read-only — no DB
//     writes.
//
//   commitImportAction — actually creates the rules. Re-runs the
//     full validate + plan path (idempotent against preview); only
//     entries with willCreate=true are persisted. Reports per-rule
//     created/skipped counts so the operator gets a final summary.
//
// Both import paths are tenant-scoped: the createdBy stamp is the
// authenticated user, tenantId is the current tenant — never trusted
// from the caller's payload. sourceTenantId in the import is purely
// informational.

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import {
  buildExportPayload,
  parseImport,
  planImport,
  ImportValidationError,
  type ImportPlan,
  type RuleExportPayload,
} from "@/lib/matching/rule-import-export";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportState {
  ok: boolean;
  message: string;
  payload?: RuleExportPayload;
}

export async function exportMatchingRulesAction(
  notes?: string
): Promise<ExportState> {
  try {
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const rules = await prisma.matchingRule.findMany({
      where: { tenantId: tenant.id, isActive: true },
      orderBy: [{ priority: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        descriptionRegex: true,
        amountMin: true,
        amountMax: true,
        actionType: true,
        counterAccountCode: true,
        memoTemplate: true,
        partyCode: true,
        priority: true,
        isActive: true,
        entityId: true,
      },
    });

    const payload = buildExportPayload({
      rules: rules.map((r) => ({
        ...r,
        amountMin: r.amountMin ? r.amountMin.toString() : null,
        amountMax: r.amountMax ? r.amountMax.toString() : null,
      })),
      sourceTenantId: tenant.id,
      notes: notes?.trim() || undefined,
    });
    return {
      ok: true,
      message: `Exported ${payload.rules.length} active rule(s)`,
      payload,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError) return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview (validate + plan)
// ─────────────────────────────────────────────────────────────────────────────

export interface PreviewImportState {
  ok: boolean;
  message: string;
  plan?: ImportPlan;
}

export async function previewImportAction(
  raw: string
): Promise<PreviewImportState> {
  try {
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    let parsed;
    try {
      parsed = parseImport(raw);
    } catch (e) {
      if (e instanceof ImportValidationError) {
        return { ok: false, message: e.message };
      }
      throw e;
    }

    const existing = await prisma.matchingRule.findMany({
      where: { tenantId: tenant.id, isActive: true },
      select: {
        id: true,
        name: true,
        descriptionRegex: true,
        amountMin: true,
        amountMax: true,
        actionType: true,
      },
    });

    const plan = planImport({
      parsed,
      existing: existing.map((r) => ({
        ...r,
        amountMin: r.amountMin ? r.amountMin.toString() : null,
        amountMax: r.amountMax ? r.amountMax.toString() : null,
      })),
    });

    return {
      ok: true,
      message: `Preview: ${plan.newCount} new, ${plan.duplicateCount} duplicate, ${plan.issueCount} issue(s)`,
      plan,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError) return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commit
// ─────────────────────────────────────────────────────────────────────────────

export interface CommitImportState {
  ok: boolean;
  message: string;
  created: number;
  skipped: number;
}

export async function commitImportAction(
  raw: string
): Promise<CommitImportState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    let parsed;
    try {
      parsed = parseImport(raw);
    } catch (e) {
      if (e instanceof ImportValidationError) {
        return { ok: false, message: e.message, created: 0, skipped: 0 };
      }
      throw e;
    }

    // Re-fetch existing INSIDE the transaction below so preview/commit
    // can't race against a concurrent rule creation. The plan from the
    // preview action is informational; the commit recomputes.
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.matchingRule.findMany({
        where: { tenantId: tenant.id, isActive: true },
        select: {
          id: true,
          name: true,
          descriptionRegex: true,
          amountMin: true,
          amountMax: true,
          actionType: true,
        },
      });
      const plan = planImport({
        parsed,
        existing: existing.map((r) => ({
          ...r,
          amountMin: r.amountMin ? r.amountMin.toString() : null,
          amountMax: r.amountMax ? r.amountMax.toString() : null,
        })),
      });

      let created = 0;
      const skipped = plan.duplicateCount + plan.issueCount;
      for (const entry of plan.entries) {
        if (!entry.willCreate) continue;
        const e = entry.entry;
        await tx.matchingRule.create({
          data: {
            tenantId: tenant.id,
            entityId: null, // entity scope is tenant-local; importer clears
            name: e.name.trim(),
            descriptionRegex: e.descriptionRegex,
            amountMin:
              e.amountMin != null ? new Decimal(e.amountMin).toFixed(4) : null,
            amountMax:
              e.amountMax != null ? new Decimal(e.amountMax).toFixed(4) : null,
            actionType: e.actionType,
            counterAccountCode:
              e.actionType === "ADJUST" ? e.counterAccountCode?.trim() ?? null : null,
            memoTemplate: e.memoTemplate?.trim() || null,
            partyCode: e.partyCode?.trim() || null,
            priority: e.priority,
            isActive: true,
            createdBy: user.email,
          },
        });
        created += 1;
      }
      return { created, skipped };
    });

    revalidatePath("/rules");
    return {
      ok: true,
      message: `Imported ${result.created} rule(s); skipped ${result.skipped}`,
      created: result.created,
      skipped: result.skipped,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return {
        ok: false,
        message: "You must be signed in.",
        created: 0,
        skipped: 0,
      };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message, created: 0, skipped: 0 };
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error",
      created: 0,
      skipped: 0,
    };
  }
}
