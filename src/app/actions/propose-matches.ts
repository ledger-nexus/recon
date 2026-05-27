"use server";

// Server Action: run the match pipeline for one bank line.
//
//   1. Fetch candidate JE lines from ledger-core (account + window).
//   2. Score each with the deterministic scorer.
//   3. If the top deterministic score is below AUTO_PROPOSE_THRESHOLD,
//      escalate to the AI suggester (Claude Haiku, prompt-cached).
//   4. Persist the AI run to AiSuggestion (always — for audit, even if
//      no candidates were returned).
//   5. Create PROPOSED ReconciliationMatch rows for the top suggestions
//      (deterministic top match always; AI top match if its confidence
//      passes the AI threshold).
//
// Humans approve / reject via separate Server Actions (decide-match.ts).
// This action never WRITES to ledger-core tables — it only reads JE lines
// and writes recon-owned tables.

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { fetchCandidateJournalLines } from "@/lib/matching/candidates";
import {
  rankCandidates,
  AUTO_PROPOSE_THRESHOLD,
  type MatchScore,
} from "@/lib/matching/deterministic";
import {
  getAiMatchSuggestions,
  type AiSuggestionResult,
} from "@/lib/matching/ai-suggest";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";
import {
  enforceAiBudget,
  emitSpendAlertIfThresholdCrossed,
  RateLimitExceededError,
  MonthlySpendCapExceededError,
} from "@/lib/auth/ai-budget";

// Below this AI-confidence, we still log the suggestion but don't create
// a PROPOSED match row — too noisy for the human approval queue.
const AI_PROPOSE_THRESHOLD = 0.6;

// Cap on PROPOSED rows we create per bank line. The UI shows them
// ranked; humans can pick one or none.
const MAX_PROPOSALS_PER_LINE = 3;

export interface ProposeMatchesState {
  ok: boolean;
  message: string;
  bankLineId?: string;
  deterministicTop?: { journalLineId: string; score: number };
  aiUsed?: boolean;
  aiTop?: { journalLineId: string; confidence: number };
}

export async function proposeMatchesAction(
  bankLineId: string
): Promise<ProposeMatchesState> {
  try {
    // SECURITY (pen-test pass 4 follow-up): require auth + tenant. This
    // action calls the Anthropic API (per-tenant cost) and writes an
    // audit row, so anonymous callers must be refused. Tenant-scoping
    // the bankLine lookup prevents cross-tenant AI invocations.
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const bankLine = await prisma.bankStatementLine.findFirst({
      where: {
        id: bankLineId,
        statement: { bankAccount: { entity: { tenantId: tenant.id } } },
      },
      select: {
        id: true,
        amount: true,
        transactionDate: true,
        description: true,
        statementId: true,
        statement: { select: { bankAccountId: true } },
      },
    });
    if (!bankLine) return { ok: false, message: "Bank line not found" };

    const bankAmount = new Decimal(bankLine.amount.toString());
    const candidateRows = await fetchCandidateJournalLines({
      bankAccountId: bankLine.statement.bankAccountId,
      bankLineAmount: bankAmount,
      bankLineDate: bankLine.transactionDate,
    });

    if (candidateRows.length === 0) {
      return {
        ok: true,
        message: "No candidate JE lines in the search window.",
        bankLineId,
      };
    }

    // Deterministic pass.
    const ranked: MatchScore[] = rankCandidates(
      {
        amount: bankAmount,
        date: bankLine.transactionDate,
        description: bankLine.description,
      },
      candidateRows
    );

    const deterministicTop = ranked[0];
    const needAi = deterministicTop.score < AUTO_PROPOSE_THRESHOLD;

    // AI pass (only when deterministic isn't already confident). The
    // rate-limit + spend-cap gate fires HERE, not at the top of the
    // action — purely-deterministic paths don't burn a slot, and the
    // bulk runner can chew through dozens of lines without tripping
    // the cap when most are obvious matches.
    let aiResult: AiSuggestionResult | null = null;
    if (needAi) {
      try {
        await enforceAiBudget({
          tenantId: tenant.id,
          userId: user.id,
          action: "proposeMatches",
        });
        aiResult = await getAiMatchSuggestions(
          {
            amount: bankAmount,
            date: bankLine.transactionDate,
            description: bankLine.description,
          },
          candidateRows
        );
      } catch (e) {
        // Re-throw budget errors so the outer catch surfaces them to
        // the UI — silently skipping a cap-blocked call would just look
        // like "no AI proposals" with no signal to the user.
        if (e instanceof RateLimitExceededError || e instanceof MonthlySpendCapExceededError) {
          throw e;
        }
        // Other AI failures are non-fatal — we still have the
        // deterministic top match. Log and continue.
        console.error("AI suggester failed for bank line", bankLineId, e);
      }
    }

    // Persist the AI run for audit (always, even when candidates is []).
    if (aiResult) {
      await prisma.aiSuggestion.create({
        data: {
          bankLineId,
          tenantId: tenant.id,
          candidatesJson: aiResult.candidates as unknown as object,
          modelName: aiResult.modelName,
          promptHash: aiResult.promptHash || null,
          promptTokens: aiResult.promptTokens,
          completionTokens: aiResult.completionTokens,
          latencyMs: aiResult.latencyMs,
        },
      });
      // Evaluate spend-threshold alerts after the just-finished call is
      // included in the tally. In the bulk action this fires once per
      // line — but the helper's per-month dedup row keeps that to at
      // most one alert delivery per threshold per calendar month.
      await emitSpendAlertIfThresholdCrossed(tenant.id);
    }

    // Assemble proposals. Deterministic top always wins a slot if its
    // score > 0 (i.e. amount matched). Then layer AI candidates that
    // pass the AI threshold and aren't already covered.
    type Proposal = {
      journalLineId: string;
      source: "DETERMINISTIC" | "AI";
      confidence: Decimal | null;
    };
    const proposals: Proposal[] = [];
    const seenJournalIds = new Set<string>();

    if (deterministicTop.score > 0) {
      proposals.push({
        journalLineId: deterministicTop.journalLineId,
        source: "DETERMINISTIC",
        // The deterministic scorer's score is informative but not stored
        // as confidence — only AI confidences are persisted there.
        confidence: null,
      });
      seenJournalIds.add(deterministicTop.journalLineId);
    }

    if (aiResult) {
      for (const c of aiResult.candidates) {
        if (proposals.length >= MAX_PROPOSALS_PER_LINE) break;
        if (c.confidence < AI_PROPOSE_THRESHOLD) continue;
        if (seenJournalIds.has(c.journalLineId)) continue;
        proposals.push({
          journalLineId: c.journalLineId,
          source: "AI",
          confidence: new Decimal(c.confidence.toFixed(4)),
        });
        seenJournalIds.add(c.journalLineId);
      }
    }

    if (proposals.length === 0) {
      return {
        ok: true,
        message: "No proposals met the threshold.",
        bankLineId,
        deterministicTop: {
          journalLineId: deterministicTop.journalLineId,
          score: deterministicTop.score,
        },
        aiUsed: aiResult !== null,
      };
    }

    // Persist proposals + flip the bank line to PROPOSED. One transaction
    // so a partial write can't leave the line in an inconsistent state.
    await prisma.$transaction(async (tx) => {
      for (const p of proposals) {
        await tx.reconciliationMatch.upsert({
          where: {
            bankLineId_journalLineId: {
              bankLineId,
              journalLineId: p.journalLineId,
            },
          },
          create: {
            bankLineId,
            journalLineId: p.journalLineId,
            source: p.source,
            confidence: p.confidence ? p.confidence.toFixed(4) : null,
            status: "PROPOSED",
          },
          update: {
            // If a prior REJECTED row exists, we don't resurrect it —
            // skip via update no-op. The unique constraint forces upsert
            // semantics; we just refresh confidence if the existing row
            // is still PROPOSED.
            confidence: p.confidence ? p.confidence.toFixed(4) : undefined,
          },
        });
      }
      await tx.bankStatementLine.update({
        where: { id: bankLineId },
        data: { status: "PROPOSED" },
      });
    });

    revalidatePath(`/statements/${bankLine.statementId}`);

    const aiTop = aiResult?.candidates[0];
    return {
      ok: true,
      message: `Proposed ${proposals.length} match${proposals.length === 1 ? "" : "es"}.`,
      bankLineId,
      deterministicTop: {
        journalLineId: deterministicTop.journalLineId,
        score: deterministicTop.score,
      },
      aiUsed: aiResult !== null,
      aiTop: aiTop
        ? { journalLineId: aiTop.journalLineId, confidence: aiTop.confidence }
        : undefined,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in.", bankLineId };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message, bankLineId };
    if (e instanceof RateLimitExceededError || e instanceof MonthlySpendCapExceededError)
      return { ok: false, message: e.message, bankLineId };
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error",
      bankLineId,
    };
  }
}

// ─── Bulk action (v1.0) ───────────────────────────────────────────────────

export interface ProposeAllState {
  ok: boolean;
  message: string;
  total?: number;          // UNMATCHED lines we attempted
  proposedCount?: number;  // lines where at least one proposal was created
  noCandidates?: number;   // lines with zero candidate JE lines in window
  belowThreshold?: number; // lines where candidates existed but none qualified
  errors?: number;         // per-line failures (counted; full set logged)
}

/**
 * Run proposeMatchesAction for every UNMATCHED line in a statement.
 *
 * Sequential by design — AI calls are rate-limited at Anthropic's side,
 * and parallelizing risks 429s without delivering meaningful speedup for
 * a typical statement (<50 lines). The trade-off is acceptable; if a
 * customer routinely uploads 500-line statements we can chunk-and-batch.
 *
 * Returns aggregate counts so the UI can render "Proposed 6 of 9 lines;
 * 2 had no candidates; 1 below confidence threshold."
 */
export async function proposeAllUnmatchedAction(
  statementId: string
): Promise<ProposeAllState> {
  try {
    // SECURITY (pen-test pass 4 follow-up): same gate as
    // proposeMatchesAction. The per-line invocation inside the loop
    // also re-checks, but failing fast here saves a DB query when the
    // caller isn't authorized.
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const lines = await prisma.bankStatementLine.findMany({
      where: {
        statementId,
        status: "UNMATCHED",
        statement: { bankAccount: { entity: { tenantId: tenant.id } } },
      },
      select: { id: true },
      orderBy: { lineNo: "asc" },
    });
    if (lines.length === 0) {
      return {
        ok: true,
        message: "No unmatched lines on this statement.",
        total: 0,
        proposedCount: 0,
        noCandidates: 0,
        belowThreshold: 0,
        errors: 0,
      };
    }

    let proposedCount = 0;
    let noCandidates = 0;
    let belowThreshold = 0;
    let errors = 0;
    let budgetStopped = false;

    for (const line of lines) {
      const result = await proposeMatchesAction(line.id);
      if (!result.ok) {
        errors += 1;
        // If the budget tripped on this line, every subsequent call
        // will also be refused — short-circuit the loop to spare the
        // DB round-trips and give the user one clear message.
        if (
          result.message.includes("Tenant rate limit") ||
          result.message.includes("User rate limit") ||
          result.message.includes("spend cap")
        ) {
          budgetStopped = true;
          break;
        }
        continue;
      }
      // The single-line action's `message` distinguishes the buckets.
      // Cheap and stable enough for an aggregate counter; full result is
      // already audit-logged via AiSuggestion rows.
      if (result.message.startsWith("Proposed ")) {
        proposedCount += 1;
      } else if (result.message.includes("No candidate")) {
        noCandidates += 1;
      } else if (result.message.includes("met the threshold")) {
        belowThreshold += 1;
      }
    }

    revalidatePath(`/statements/${statementId}`);

    // Human-readable summary; the UI also surfaces structured counts.
    const parts: string[] = [];
    if (proposedCount > 0) parts.push(`${proposedCount} proposed`);
    if (noCandidates > 0) parts.push(`${noCandidates} with no candidates`);
    if (belowThreshold > 0) parts.push(`${belowThreshold} below threshold`);
    if (errors > 0) parts.push(`${errors} errored`);
    if (budgetStopped) parts.push("stopped early at AI budget limit");
    const summary = parts.length > 0 ? parts.join(", ") : "no changes";

    return {
      ok: true,
      message: `Processed ${lines.length} unmatched line${lines.length === 1 ? "" : "s"}: ${summary}.`,
      total: lines.length,
      proposedCount,
      noCandidates,
      belowThreshold,
      errors,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error",
    };
  }
}
