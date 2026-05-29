"use server";

// Statement-level bulk actions:
//
//   applyRulesToStatementAction — loads all ACTIVE MatchingRules for
//     the tenant, evaluates every UNMATCHED line on the statement,
//     executes the winning rule's action (IGNORE the line or post an
//     ADJUST JE via the ledger-core bridge), and returns aggregate
//     counts + per-rule breakdown.
//
//   bulkApproveHighConfidenceAction — for statements where the AI
//     suggester has already run, approve every PROPOSED match whose
//     top candidate clears a confidence threshold (default 90%) with
//     one click. Skips lines that have no PROPOSED match or whose
//     match is below threshold.
//
// Both are designed to be re-runnable: the underlying decideMatch and
// post-adjustment actions short-circuit on already-MATCHED /
// already-ADJUSTMENT lines, so a second click is safe.

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import {
  compileRules,
  sortRulesByPriority,
  findMatchingRule,
  renderRuleMemo,
  RuleCompileError,
  type RuleSpec,
  type CompiledRule,
  type BankLineForRules,
} from "@/lib/matching/rules";
import {
  postEntryViaLedgerCore,
  LedgerCoreError,
  friendlyLedgerError,
  type LedgerJournalEntryInput,
} from "@/lib/ledger-bridge";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";
import {
  assertStatementOpen,
  StatementReconciledError,
  StatementNotFoundError,
} from "@/lib/statement-lock";

// ─────────────────────────────────────────────────────────────────────────────
// applyRulesToStatementAction
// ─────────────────────────────────────────────────────────────────────────────

export interface ApplyRulesResult {
  ok: boolean;
  message: string;
  /** Number of lines a rule claimed and the action was executed on. */
  matched: number;
  /** Number of lines no rule matched. */
  unmatched: number;
  /** Number of lines that errored during action execution. */
  failed: number;
  /** Per-line outcome detail (the UI surfaces this in a dialog). */
  lines: Array<{
    bankLineId: string;
    description: string;
    outcome: "IGNORED" | "ADJUSTED" | "NO_RULE" | "FAILED" | "ALREADY_RESOLVED";
    ruleId?: string;
    ruleName?: string;
    entryNumber?: string;
    error?: string;
  }>;
}

export async function applyRulesToStatementAction(
  statementId: string
): Promise<ApplyRulesResult> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    await assertStatementOpen(prisma, { tenantId: tenant.id, statementId });

    // Tenant-scoped statement + lines fetch.
    const statement = await prisma.bankStatement.findFirst({
      where: { id: statementId, bankAccount: { entity: { tenantId: tenant.id } } },
      select: {
        id: true,
        bankAccount: {
          select: {
            entity: { select: { id: true, code: true } },
            account: { select: { code: true } },
          },
        },
        lines: {
          where: { status: { in: ["UNMATCHED", "PROPOSED"] } },
          select: {
            id: true,
            status: true,
            description: true,
            amount: true,
            transactionDate: true,
            statementId: true,
          },
          orderBy: { lineNo: "asc" },
        },
      },
    });
    if (!statement) {
      return {
        ok: false,
        message: "Statement not found in this tenant",
        matched: 0,
        unmatched: 0,
        failed: 0,
        lines: [],
      };
    }

    // Fetch all ACTIVE rules for this tenant. The query is small
    // (rules per tenant are typically <100); loading all in-memory
    // is fine.
    const dbRules = await prisma.matchingRule.findMany({
      where: { tenantId: tenant.id, isActive: true },
      select: {
        id: true,
        name: true,
        descriptionRegex: true,
        amountMin: true,
        amountMax: true,
        priority: true,
        isActive: true,
        actionType: true,
        counterAccountCode: true,
        memoTemplate: true,
        partyCode: true,
        entityId: true,
      },
    });

    if (dbRules.length === 0) {
      return {
        ok: true,
        message: "No active rules to apply",
        matched: 0,
        unmatched: statement.lines.length,
        failed: 0,
        lines: statement.lines.map((l) => ({
          bankLineId: l.id,
          description: l.description,
          outcome: "NO_RULE" as const,
        })),
      };
    }

    let compiled: CompiledRule[];
    try {
      compiled = compileRules(
        dbRules.map((r) => ({
          id: r.id,
          name: r.name,
          descriptionRegex: r.descriptionRegex,
          amountMin: r.amountMin ? r.amountMin.toString() : null,
          amountMax: r.amountMax ? r.amountMax.toString() : null,
          priority: r.priority,
          isActive: r.isActive,
          actionType: r.actionType,
          counterAccountCode: r.counterAccountCode,
          memoTemplate: r.memoTemplate,
          partyCode: r.partyCode,
          entityId: r.entityId,
        }))
      );
    } catch (e) {
      if (e instanceof RuleCompileError) {
        return {
          ok: false,
          message: `Rule compile error: ${e.message}`,
          matched: 0,
          unmatched: 0,
          failed: 0,
          lines: [],
        };
      }
      throw e;
    }
    const sorted = sortRulesByPriority(compiled);

    // Iterate lines, find matching rule, execute action.
    let matched = 0;
    let unmatched = 0;
    let failed = 0;
    const outcomes: ApplyRulesResult["lines"] = [];
    // Track rule fires so we can bump applicationCount + lastAppliedAt
    // once at the end.
    const ruleHits = new Map<string, number>();

    for (const lineRow of statement.lines) {
      const lineForRules: BankLineForRules = {
        id: lineRow.id,
        description: lineRow.description,
        amount: lineRow.amount.toString(),
        transactionDate: lineRow.transactionDate,
        entityId: statement.bankAccount.entity.id,
      };
      const winner = findMatchingRule(sorted, lineForRules);
      if (!winner) {
        unmatched += 1;
        outcomes.push({
          bankLineId: lineRow.id,
          description: lineRow.description,
          outcome: "NO_RULE",
        });
        continue;
      }

      ruleHits.set(winner.spec.id, (ruleHits.get(winner.spec.id) ?? 0) + 1);

      try {
        if (winner.spec.actionType === "IGNORE") {
          await applyIgnoreAction({
            bankLineId: lineRow.id,
            statementId: lineRow.statementId,
            userEmail: user.email,
            ruleName: winner.spec.name,
            previousStatus: lineRow.status as "UNMATCHED" | "PROPOSED",
          });
          matched += 1;
          outcomes.push({
            bankLineId: lineRow.id,
            description: lineRow.description,
            outcome: "IGNORED",
            ruleId: winner.spec.id,
            ruleName: winner.spec.name,
          });
        } else {
          // ADJUST
          const posted = await applyAdjustAction({
            bankLine: lineRow,
            entityCode: statement.bankAccount.entity.code,
            cashAccountCode: statement.bankAccount.account.code,
            counterAccountCode: winner.spec.counterAccountCode!,
            memo: renderRuleMemo(winner, lineForRules),
            partyCode: winner.spec.partyCode ?? undefined,
            userEmail: user.email,
            previousStatus: lineRow.status as "UNMATCHED" | "PROPOSED",
          });
          matched += 1;
          outcomes.push({
            bankLineId: lineRow.id,
            description: lineRow.description,
            outcome: "ADJUSTED",
            ruleId: winner.spec.id,
            ruleName: winner.spec.name,
            entryNumber: posted.entryNumber,
          });
        }
      } catch (e) {
        failed += 1;
        const errMsg =
          e instanceof LedgerCoreError
            ? friendlyLedgerError(e)
            : e instanceof Error
              ? e.message
              : "Unknown error";
        outcomes.push({
          bankLineId: lineRow.id,
          description: lineRow.description,
          outcome: "FAILED",
          ruleId: winner.spec.id,
          ruleName: winner.spec.name,
          error: errMsg,
        });
        // Don't abort the batch — one failed line shouldn't stop the
        // operator from getting the other 49 done.
      }
    }

    // Bump applicationCount + lastAppliedAt for each rule that fired.
    if (ruleHits.size > 0) {
      const now = new Date();
      await prisma.$transaction(
        Array.from(ruleHits.entries()).map(([ruleId, count]) =>
          prisma.matchingRule.update({
            where: { id: ruleId },
            data: {
              applicationCount: { increment: count },
              lastAppliedAt: now,
            },
          })
        )
      );
    }

    revalidatePath(`/statements/${statementId}`);
    return {
      ok: true,
      message: `Applied: ${matched} matched · ${unmatched} no-rule · ${failed} failed`,
      matched,
      unmatched,
      failed,
      lines: outcomes,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return {
        ok: false,
        message: "You must be signed in.",
        matched: 0,
        unmatched: 0,
        failed: 0,
        lines: [],
      };
    }
    if (e instanceof NoTenantSelectedError) {
      return { ok: false, message: e.message, matched: 0, unmatched: 0, failed: 0, lines: [] };
    }
    if (e instanceof StatementReconciledError || e instanceof StatementNotFoundError) {
      return { ok: false, message: e.message, matched: 0, unmatched: 0, failed: 0, lines: [] };
    }
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error",
      matched: 0,
      unmatched: 0,
      failed: 0,
      lines: [],
    };
  }
}

// ─── Per-action helpers ──────────────────────────────────────────────────────

async function applyIgnoreAction(input: {
  bankLineId: string;
  statementId: string;
  userEmail: string;
  ruleName: string;
  previousStatus: "UNMATCHED" | "PROPOSED";
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Conditional transition guards against per-line races (concurrent
    // Apply rules invocations claiming the same line). If 0 rows
    // affected, the line was already resolved — throw and skip.
    const transitionResult = await tx.bankStatementLine.updateMany({
      where: {
        id: input.bankLineId,
        status: { in: ["UNMATCHED", "PROPOSED"] },
      },
      data: {
        status: "IGNORED",
        ignoredAt: new Date(),
        ignoredBy: input.userEmail,
        ignoreReason: `Auto-ignored by rule '${input.ruleName}'`,
      },
    });
    if (transitionResult.count === 0) {
      throw new Error(
        `Bank line was already resolved by a concurrent action — skipping`
      );
    }
    // Withdraw any PROPOSED matches that were sitting on this line.
    await tx.reconciliationMatch.updateMany({
      where: { bankLineId: input.bankLineId, status: "PROPOSED" },
      data: { status: "WITHDRAWN" },
    });
    // Statement counter — line transitioned from pending to resolved.
    await tx.bankStatement.update({
      where: { id: input.statementId },
      data: {
        matchedLines: { increment: 1 },
        pendingLines: { decrement: 1 },
      },
    });
  });
}

async function applyAdjustAction(input: {
  bankLine: {
    id: string;
    amount: { toString(): string };
    transactionDate: Date;
    description: string;
    status: string;
    statementId: string;
  };
  entityCode: string;
  cashAccountCode: string;
  counterAccountCode: string;
  memo: string;
  partyCode?: string;
  userEmail: string;
  previousStatus: "UNMATCHED" | "PROPOSED";
}): Promise<{ entryNumber: string; entryId: string }> {
  const signedAmount = new Decimal(input.bankLine.amount.toString());
  const absAmount = signedAmount.abs();
  if (absAmount.isZero()) {
    throw new Error("Cannot post a $0 adjustment");
  }

  const cashIsDebit = signedAmount.isPositive();
  const cashLine = cashIsDebit
    ? { accountCode: input.cashAccountCode, debit: absAmount }
    : { accountCode: input.cashAccountCode, credit: absAmount };
  const counterLine = cashIsDebit
    ? {
        accountCode: input.counterAccountCode,
        credit: absAmount,
        partyCode: input.partyCode,
      }
    : {
        accountCode: input.counterAccountCode,
        debit: absAmount,
        partyCode: input.partyCode,
      };

  const entryInput: LedgerJournalEntryInput = {
    entityCode: input.entityCode,
    documentDate: input.bankLine.transactionDate,
    memo: input.memo,
    source: "MANUAL",
    lines: [cashLine, counterLine],
    sourceSystem: "recon",
    sourceRecordType: "bank-line-rule-adjustment",
    sourceRecordId: input.bankLine.id,
  };

  // ATOMICITY + PER-LINE RACE: wrap bridge call + local writes in one
  // transaction. Audit-pass fix.
  //
  // applyRulesToStatementAction selects all UNMATCHED/PROPOSED lines
  // up front, then loops without re-checking each line's status before
  // posting. A double-click on "Apply rules" could pass the initial
  // selection check and then both calls would post to ledger-core.
  // The bridge dedupes by sourceRecordId, so no double JE upstream —
  // but the per-line ReconciliationMatch + statement counter writes
  // would run twice locally, double-creating matches and
  // double-incrementing counters.
  //
  // Fix: switch the bank-line transition to a conditional
  // updateMany — if 0 rows match (line was already resolved by a
  // concurrent run), throw and skip the rest of the local writes.
  // Wrap bridge inside the txn so local + remote either both happen
  // or both don't.
  let postedRef!: { id: string; entryNumber: string };
  await prisma.$transaction(
    async (tx) => {
      const posted = await postEntryViaLedgerCore(entryInput);

      const cashJeLine = await tx.journalLine.findUnique({
        where: { entryId_lineNo: { entryId: posted.id, lineNo: 1 } },
        select: { id: true },
      });
      if (!cashJeLine) {
        throw new Error(
          `Posted entry ${posted.entryNumber} but could not locate its cash line — refusing to leave dangling match`
        );
      }

      // Conditional transition: only flip to ADJUSTMENT if the line
      // is STILL in a pre-resolved state. updateMany returns the
      // count; 0 means a concurrent run beat us to it.
      const transitionResult = await tx.bankStatementLine.updateMany({
        where: {
          id: input.bankLine.id,
          status: { in: ["UNMATCHED", "PROPOSED"] },
        },
        data: { status: "ADJUSTMENT" },
      });
      if (transitionResult.count === 0) {
        throw new Error(
          `Bank line was already resolved by a concurrent action — skipping`
        );
      }

      await tx.reconciliationMatch.create({
        data: {
          bankLineId: input.bankLine.id,
          journalLineId: cashJeLine.id,
          source: "MANUAL",
          confidence: null,
          status: "APPROVED",
          appliedByEntryId: posted.id,
          approvedAt: new Date(),
          approvedBy: input.userEmail,
        },
      });
      await tx.reconciliationMatch.updateMany({
        where: { bankLineId: input.bankLine.id, status: "PROPOSED" },
        data: { status: "WITHDRAWN" },
      });
      await tx.bankStatement.update({
        where: { id: input.bankLine.statementId },
        data: {
          matchedLines: { increment: 1 },
          pendingLines: { decrement: 1 },
        },
      });
      postedRef = { id: posted.id, entryNumber: posted.entryNumber };
    },
    { timeout: 30_000 }
  );
  const posted = postedRef;

  return { entryNumber: posted.entryNumber, entryId: posted.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// bulkApproveHighConfidenceAction
// ─────────────────────────────────────────────────────────────────────────────

export interface BulkApproveResult {
  ok: boolean;
  message: string;
  approved: number;
  skipped: number;
  /** Lines whose best PROPOSED match was below threshold. */
  belowThreshold: number;
  failures: Array<{ matchId: string; bankLineId: string; reason: string }>;
}

export async function bulkApproveHighConfidenceAction(input: {
  statementId: string;
  /** Confidence threshold in 0..1. Default 0.9 = "90%+ auto-approve". */
  threshold?: number;
}): Promise<BulkApproveResult> {
  const threshold = input.threshold ?? 0.9;
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    await assertStatementOpen(prisma, { tenantId: tenant.id, statementId: input.statementId });

    const statement = await prisma.bankStatement.findFirst({
      where: {
        id: input.statementId,
        bankAccount: { entity: { tenantId: tenant.id } },
      },
      select: {
        id: true,
        lines: {
          where: { status: "PROPOSED" },
          select: {
            id: true,
            matches: {
              where: { status: "PROPOSED" },
              orderBy: { confidence: "desc" },
              take: 1,
              select: { id: true, confidence: true },
            },
          },
        },
      },
    });
    if (!statement) {
      return {
        ok: false,
        message: "Statement not found in this tenant",
        approved: 0,
        skipped: 0,
        belowThreshold: 0,
        failures: [],
      };
    }

    let approved = 0;
    let belowThreshold = 0;
    const failures: BulkApproveResult["failures"] = [];

    for (const bankLine of statement.lines) {
      const top = bankLine.matches[0];
      if (!top || top.confidence == null) {
        // No top match (shouldn't happen since we filtered status=PROPOSED)
        // or no confidence (deterministic-only without an AI score). Skip.
        belowThreshold += 1;
        continue;
      }
      const conf = new Decimal(top.confidence.toString());
      if (conf.lessThan(threshold)) {
        belowThreshold += 1;
        continue;
      }

      try {
        await prisma.$transaction(async (tx) => {
          await tx.reconciliationMatch.update({
            where: { id: top.id },
            data: {
              status: "APPROVED",
              approvedAt: new Date(),
              approvedBy: user.email,
            },
          });
          await tx.reconciliationMatch.updateMany({
            where: {
              bankLineId: bankLine.id,
              id: { not: top.id },
              status: "PROPOSED",
            },
            data: { status: "WITHDRAWN" },
          });
          await tx.bankStatementLine.update({
            where: { id: bankLine.id },
            data: { status: "MATCHED" },
          });
          await tx.bankStatement.update({
            where: { id: input.statementId },
            data: {
              matchedLines: { increment: 1 },
              pendingLines: { decrement: 1 },
            },
          });
        });
        approved += 1;
      } catch (e) {
        failures.push({
          matchId: top.id,
          bankLineId: bankLine.id,
          reason: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }

    revalidatePath(`/statements/${input.statementId}`);
    const pctLabel = `${(threshold * 100).toFixed(0)}%`;
    return {
      ok: true,
      message: `Approved ${approved} match${approved === 1 ? "" : "es"} at ≥ ${pctLabel} confidence; ${belowThreshold} below threshold; ${failures.length} failed`,
      approved,
      skipped: 0,
      belowThreshold,
      failures,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return {
        ok: false,
        message: "You must be signed in.",
        approved: 0,
        skipped: 0,
        belowThreshold: 0,
        failures: [],
      };
    }
    if (e instanceof NoTenantSelectedError) {
      return {
        ok: false,
        message: e.message,
        approved: 0,
        skipped: 0,
        belowThreshold: 0,
        failures: [],
      };
    }
    if (e instanceof StatementReconciledError || e instanceof StatementNotFoundError) {
      return {
        ok: false,
        message: e.message,
        approved: 0,
        skipped: 0,
        belowThreshold: 0,
        failures: [],
      };
    }
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error",
      approved: 0,
      skipped: 0,
      belowThreshold: 0,
      failures: [],
    };
  }
}
