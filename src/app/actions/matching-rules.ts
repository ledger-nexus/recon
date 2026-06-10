"use server";

// CRUD Server Actions for MatchingRule.
//
// Rule lifecycle:
//
//   createMatchingRuleAction — operator defines a new rule. Validates
//     the regex compiles + the action shape is consistent (ADJUST needs
//     counterAccountCode, IGNORE doesn't). New rules default to
//     priority 100 + isActive=true.
//
//   updateMatchingRuleAction — edit any field on an existing rule.
//     Same validation as create. Preserves applicationCount /
//     lastAppliedAt — those track the rule's history regardless of
//     edits.
//
//   deleteMatchingRuleAction — soft-delete via isActive=false. Hard
//     delete would lose the audit trail (which lines were classified
//     by which rule, via the memo field on the resulting JEs). The
//     rule stays in the DB; the apply engine just stops picking it.
//
// All actions are tenant-scoped: the rule's tenantId is set from the
// authenticated tenant (not caller input), and update/delete refuse
// to touch a rule that belongs to a different tenant.

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { compileRuleRegex, RuleCompileError } from "@/lib/matching/rules";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";

export type RuleActionType = "IGNORE" | "ADJUST";

export interface CreateRuleInput {
  name: string;
  descriptionRegex: string;
  amountMin?: number | null;
  amountMax?: number | null;
  actionType: RuleActionType;
  counterAccountCode?: string | null;
  memoTemplate?: string | null;
  partyCode?: string | null;
  priority?: number;
  entityId?: string | null;
}

export interface UpdateRuleInput extends Partial<CreateRuleInput> {
  ruleId: string;
  isActive?: boolean;
}

export interface RuleActionState {
  ok: boolean;
  message: string;
  ruleId?: string;
}

/**
 * Shared validation. Throws RuleCompileError or Error with a friendly
 * message; the caller catches and surfaces.
 */
function validateRuleShape(input: {
  name?: string;
  descriptionRegex?: string;
  actionType?: RuleActionType;
  counterAccountCode?: string | null;
  amountMin?: number | null;
  amountMax?: number | null;
}): void {
  if (input.name !== undefined && input.name.trim().length === 0) {
    throw new Error("Name is required");
  }
  if (input.descriptionRegex !== undefined) {
    // Throws RuleCompileError with a specific reason.
    compileRuleRegex(input.descriptionRegex);
  }
  if (input.actionType === "ADJUST") {
    if (!input.counterAccountCode || input.counterAccountCode.trim().length === 0) {
      throw new Error("ADJUST rules require a counter-account code");
    }
  }
  if (
    input.amountMin != null &&
    input.amountMax != null &&
    input.amountMin > input.amountMax
  ) {
    throw new Error(
      `amountMin (${input.amountMin}) cannot exceed amountMax (${input.amountMax})`
    );
  }
}

export async function createMatchingRuleAction(
  input: CreateRuleInput
): Promise<RuleActionState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    validateRuleShape(input);

    const created = await prisma.matchingRule.create({
      data: {
        tenantId: tenant.id,
        entityId: input.entityId ?? null,
        name: input.name.trim(),
        descriptionRegex: input.descriptionRegex,
        amountMin: input.amountMin != null ? new Decimal(input.amountMin).toFixed(4) : null,
        amountMax: input.amountMax != null ? new Decimal(input.amountMax).toFixed(4) : null,
        actionType: input.actionType,
        counterAccountCode:
          input.actionType === "ADJUST" ? input.counterAccountCode!.trim() : null,
        memoTemplate: input.memoTemplate?.trim() || null,
        partyCode: input.partyCode?.trim() || null,
        priority: input.priority ?? 100,
        isActive: true,
        createdBy: user.email,
      },
      select: { id: true },
    });

    revalidatePath("/rules");
    return { ok: true, message: `Rule '${input.name}' created`, ruleId: created.id };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError) return { ok: false, message: e.message };
    if (e instanceof RuleCompileError) return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function updateMatchingRuleAction(
  input: UpdateRuleInput
): Promise<RuleActionState> {
  try {
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const target = await prisma.matchingRule.findFirst({
      where: { id: input.ruleId, tenantId: tenant.id },
      select: { id: true, actionType: true, counterAccountCode: true },
    });
    if (!target) return { ok: false, message: "Rule not found in this tenant" };

    // Merge for validation: missing fields fall back to existing
    // values so partial updates don't fail on unrelated invariants.
    const effective = {
      name: input.name,
      descriptionRegex: input.descriptionRegex,
      actionType: input.actionType ?? (target.actionType as RuleActionType),
      counterAccountCode:
        input.counterAccountCode !== undefined
          ? input.counterAccountCode
          : target.counterAccountCode,
      amountMin: input.amountMin,
      amountMax: input.amountMax,
    };
    validateRuleShape(effective);

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.descriptionRegex !== undefined) data.descriptionRegex = input.descriptionRegex;
    if (input.amountMin !== undefined) {
      data.amountMin = input.amountMin != null ? new Decimal(input.amountMin).toFixed(4) : null;
    }
    if (input.amountMax !== undefined) {
      data.amountMax = input.amountMax != null ? new Decimal(input.amountMax).toFixed(4) : null;
    }
    if (input.actionType !== undefined) {
      data.actionType = input.actionType;
      // When switching to IGNORE, blank out the now-irrelevant counter
      // account so an inactive value isn't carried forward.
      if (input.actionType === "IGNORE") data.counterAccountCode = null;
    }
    if (input.counterAccountCode !== undefined && effective.actionType === "ADJUST") {
      data.counterAccountCode = input.counterAccountCode?.trim() ?? null;
    }
    if (input.memoTemplate !== undefined) data.memoTemplate = input.memoTemplate?.trim() || null;
    if (input.partyCode !== undefined) data.partyCode = input.partyCode?.trim() || null;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.entityId !== undefined) data.entityId = input.entityId;

    await prisma.matchingRule.update({ where: { id: target.id }, data });

    revalidatePath("/rules");
    return { ok: true, message: "Rule updated", ruleId: target.id };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError) return { ok: false, message: e.message };
    if (e instanceof RuleCompileError) return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function deleteMatchingRuleAction(
  ruleId: string
): Promise<RuleActionState> {
  try {
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    const target = await prisma.matchingRule.findFirst({
      where: { id: ruleId, tenantId: tenant.id },
      select: { id: true },
    });
    if (!target) return { ok: false, message: "Rule not found in this tenant" };

    // Soft-delete: keep the row + audit trail, just stop picking it up.
    await prisma.matchingRule.update({
      where: { id: target.id },
      data: { isActive: false },
    });
    revalidatePath("/rules");
    return { ok: true, message: "Rule deactivated", ruleId };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError) return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
