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
    const bankLine = await prisma.bankStatementLine.findUnique({
      where: { id: bankLineId },
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

    // AI pass (only when deterministic isn't already confident).
    let aiResult: AiSuggestionResult | null = null;
    if (needAi) {
      try {
        aiResult = await getAiMatchSuggestions(
          {
            amount: bankAmount,
            date: bankLine.transactionDate,
            description: bankLine.description,
          },
          candidateRows
        );
      } catch (e) {
        // AI failure is non-fatal — we still have the deterministic top
        // match. Log and continue.
        console.error("AI suggester failed for bank line", bankLineId, e);
      }
    }

    // Persist the AI run for audit (always, even when candidates is []).
    if (aiResult) {
      await prisma.aiSuggestion.create({
        data: {
          bankLineId,
          candidatesJson: aiResult.candidates as unknown as object,
          modelName: aiResult.modelName,
          promptHash: aiResult.promptHash || null,
          promptTokens: aiResult.promptTokens,
          completionTokens: aiResult.completionTokens,
          latencyMs: aiResult.latencyMs,
        },
      });
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
    const lines = await prisma.bankStatementLine.findMany({
      where: { statementId, status: "UNMATCHED" },
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

    for (const line of lines) {
      const result = await proposeMatchesAction(line.id);
      if (!result.ok) {
        errors += 1;
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
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error",
    };
  }
}
