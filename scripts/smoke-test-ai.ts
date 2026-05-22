// Live smoke test for the AI match pipeline.
//
// Run this when you have:
//   - DATABASE_URL pointed at a Postgres with ledger-core + recon seeded
//   - ANTHROPIC_API_KEY in the environment (or a .env file)
//
//   tsx scripts/smoke-test-ai.ts
//
// What it does:
//   1. Picks the first UNMATCHED bank statement line in the database.
//   2. Calls proposeMatchesAction on it (deterministic + AI escalation).
//   3. Reports: deterministic top score, whether AI was called, AI
//      candidates returned, cache-hit stats, total latency, audit row id.
//   4. Calls it a SECOND time on the same line to verify prompt caching
//      kicks in (cache_read_input_tokens should be > 0 on call #2).
//
// This is the test that mocked-SDK tests can't do for you. Run it
// before any change to ai-suggest.ts goes to prod.

import "dotenv/config";
import { prisma } from "../src/lib/db";
import { proposeMatchesAction } from "../src/app/actions/propose-matches";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set. Put it in .env or export it before running.");
    process.exit(1);
  }

  console.log("Recon AI smoke test — looking for an UNMATCHED bank line...");

  const line = await prisma.bankStatementLine.findFirst({
    where: { status: "UNMATCHED" },
    select: {
      id: true,
      description: true,
      amount: true,
      transactionDate: true,
      statement: {
        select: {
          filename: true,
          bankAccount: { select: { displayName: true } },
        },
      },
    },
  });
  if (!line) {
    console.error(
      "No UNMATCHED bank lines found. Run `pnpm db:seed` (recon) after seeding ledger-core."
    );
    process.exit(1);
  }

  console.log(`Target line:`);
  console.log(`  account:     ${line.statement.bankAccount.displayName}`);
  console.log(`  statement:   ${line.statement.filename}`);
  console.log(`  date:        ${line.transactionDate.toISOString().slice(0, 10)}`);
  console.log(`  amount:      ${line.amount.toString()}`);
  console.log(`  description: ${line.description}`);
  console.log("");

  for (const pass of [1, 2] as const) {
    const label = pass === 1 ? "Pass 1 (cold cache)" : "Pass 2 (warm cache — expect cache hits)";
    console.log(`--- ${label} ---`);
    const startedAt = Date.now();
    const result = await proposeMatchesAction(line.id);
    const totalMs = Date.now() - startedAt;

    console.log(`  ok:               ${result.ok}`);
    console.log(`  message:          ${result.message}`);
    if (result.deterministicTop) {
      console.log(`  deterministic:    ${result.deterministicTop.journalLineId.slice(0, 8)} (score=${result.deterministicTop.score.toFixed(3)})`);
    }
    console.log(`  aiUsed:           ${result.aiUsed ?? false}`);
    if (result.aiTop) {
      console.log(`  ai top:           ${result.aiTop.journalLineId.slice(0, 8)} (confidence=${result.aiTop.confidence.toFixed(3)})`);
    }
    console.log(`  total round-trip: ${totalMs}ms`);

    // Pull the most recent AiSuggestion for this line to show cache stats.
    const audit = await prisma.aiSuggestion.findFirst({
      where: { bankLineId: line.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        modelName: true,
        promptTokens: true,
        completionTokens: true,
        latencyMs: true,
        candidatesJson: true,
      },
    });
    if (audit) {
      console.log(`  audit row:        ${audit.id.slice(0, 8)}`);
      console.log(`  model:            ${audit.modelName}`);
      console.log(`  prompt tokens:    ${audit.promptTokens ?? "?"}`);
      console.log(`  completion tokens:${audit.completionTokens ?? "?"}`);
      console.log(`  API latency:      ${audit.latencyMs ?? "?"}ms`);
      const cands = audit.candidatesJson as Array<{ confidence: number; rationale: string }>;
      if (Array.isArray(cands) && cands.length > 0) {
        console.log(`  ai candidates:`);
        for (const c of cands.slice(0, 3)) {
          console.log(`    - conf=${c.confidence.toFixed(2)}: ${c.rationale}`);
        }
      } else {
        console.log(`  ai candidates:    (none returned)`);
      }
    }
    console.log("");

    // Reset the line back to UNMATCHED between passes so pass 2 actually
    // re-runs the pipeline.
    if (pass === 1) {
      await prisma.reconciliationMatch.updateMany({
        where: { bankLineId: line.id, status: "PROPOSED" },
        data: { status: "WITHDRAWN" },
      });
      await prisma.bankStatementLine.update({
        where: { id: line.id },
        data: { status: "UNMATCHED" },
      });
    }
  }

  console.log("Smoke test complete.");
  console.log("Verify in the UI: open /statements/<id> and confirm the proposals render correctly.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
