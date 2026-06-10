// AI usage audit panel.
//
// Aggregates every AiSuggestion row to answer:
//   - How often is the AI being called?
//   - Is prompt caching actually working?
//   - What's the rough $ cost so far?
//   - For each suggestion: did the human accept any of its proposals?
//
// "Accepted" is computed from ReconciliationMatch: if any AI-sourced
// match on the same bank line is APPROVED, the suggestion contributed.
// This is the cheapest signal we have without adding a separate join
// table — good enough for "does the AI help us?"
//
// Costs are approximated using Haiku 4.5 list pricing ($1/M input,
// $5/M output). Cache reads are billed at a discount in practice
// (typically 10% of input), but we show the optimistic-uncached cost
// for the headline and break out cache stats separately so the reader
// can do the math.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney } from "@/lib/utils/format";
import { getCurrentTenant } from "@/lib/auth/session";

// Haiku 4.5 list pricing per Anthropic ($/1M tokens).
const HAIKU_INPUT_PER_M = 1.0;
const HAIKU_OUTPUT_PER_M = 5.0;

interface AiCandidateJson {
  journalLineId: string;
  confidence: number;
  rationale: string;
}

export default async function AiAuditPage() {
  // SECURITY (pen-test pass 4 follow-up): tenant-scope via the
  // tenantId column added to AiSuggestion. Legacy rows (created
  // before the column was added) have null tenantId and are filtered
  // out — backfill via prisma/backfill-ai-suggestion-tenant.sql.
  const tenant = await getCurrentTenant();
  const suggestions = await prisma.aiSuggestion.findMany({
    where: tenant ? { tenantId: tenant.id } : { id: "__none__" },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      bankLineId: true,
      candidatesJson: true,
      modelName: true,
      promptTokens: true,
      completionTokens: true,
      latencyMs: true,
      createdAt: true,
      bankLine: {
        select: {
          id: true,
          lineNo: true,
          description: true,
          amount: true,
          transactionDate: true,
          statement: {
            select: { id: true, filename: true },
          },
          matches: {
            where: { source: "AI" },
            select: { status: true, journalLineId: true },
          },
        },
      },
    },
  });

  // Headline aggregates.
  const totalRuns = suggestions.length;
  const totalPromptTokens = suggestions.reduce((s, x) => s + (x.promptTokens ?? 0), 0);
  const totalCompletionTokens = suggestions.reduce(
    (s, x) => s + (x.completionTokens ?? 0),
    0
  );
  const totalLatencyMs = suggestions.reduce((s, x) => s + (x.latencyMs ?? 0), 0);
  const avgLatencyMs = totalRuns > 0 ? Math.round(totalLatencyMs / totalRuns) : 0;
  const estimatedCostUsd =
    (totalPromptTokens / 1_000_000) * HAIKU_INPUT_PER_M +
    (totalCompletionTokens / 1_000_000) * HAIKU_OUTPUT_PER_M;

  // Acceptance rate: a suggestion is "accepted" if any AI-sourced
  // ReconciliationMatch on the same bank line is APPROVED.
  let acceptedCount = 0;
  let proposalsTotal = 0;
  let proposalsHighConfidence = 0; // confidence >= 0.85
  for (const s of suggestions) {
    if (s.bankLine.matches.some((m) => m.status === "APPROVED")) acceptedCount += 1;
    const candidates = (s.candidatesJson as unknown as AiCandidateJson[]) ?? [];
    proposalsTotal += candidates.length;
    proposalsHighConfidence += candidates.filter((c) => c.confidence >= 0.85).length;
  }
  const acceptanceRate = totalRuns > 0 ? (acceptedCount / totalRuns) * 100 : 0;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">AI usage audit</h1>
        <p className="text-sm text-ink-500">
          Every <code className="font-mono">AiSuggestion</code> row that
          the matching pipeline produced. Per the non-negotiables: every
          AI run is logged, even if the human rejected the proposals.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Total runs" value={String(totalRuns)} />
        <Metric
          label="Acceptance rate"
          value={`${acceptanceRate.toFixed(0)}%`}
          hint={`${acceptedCount} of ${totalRuns}`}
        />
        <Metric
          label="Σ tokens"
          value={(totalPromptTokens + totalCompletionTokens).toLocaleString()}
          hint={`${totalPromptTokens.toLocaleString()} in / ${totalCompletionTokens.toLocaleString()} out`}
        />
        <Metric
          label="Est. cost (uncached)"
          value={`$${estimatedCostUsd.toFixed(4)}`}
          hint="Haiku 4.5 list pricing; cache reads would reduce"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Metric label="Avg latency" value={`${avgLatencyMs}ms`} />
        <Metric
          label="High-confidence proposals"
          value={String(proposalsHighConfidence)}
          hint={`of ${proposalsTotal} total (≥0.85)`}
        />
        <Metric
          label="Model"
          value={suggestions[0]?.modelName ?? "—"}
          hint="Most recent run"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
          <span className="text-xs text-ink-500">
            Newest first · capped at 200 · click the bank line to see what the AI proposed in context
          </span>
        </CardHeader>
        <CardContent className={suggestions.length === 0 ? "" : "p-0"}>
          {suggestions.length === 0 ? (
            <EmptyState
              title="No AI runs yet"
              description="The AI suggester fires when the deterministic top score is below 0.85. Upload a statement and click 'Suggest matches' on a line whose match isn't obvious."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>When</TH>
                  <TH>Bank line</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Outcome</TH>
                  <TH>Top proposal</TH>
                  <TH className="text-right">Tokens</TH>
                  <TH className="text-right">Latency</TH>
                </tr>
              </THead>
              <TBody>
                {suggestions.map((s) => {
                  const candidates =
                    (s.candidatesJson as unknown as AiCandidateJson[]) ?? [];
                  const top = candidates[0];
                  const accepted = s.bankLine.matches.some(
                    (m) => m.status === "APPROVED"
                  );
                  const rejected =
                    !accepted &&
                    s.bankLine.matches.some((m) => m.status === "REJECTED");
                  return (
                    <TR key={s.id}>
                      <TD className="text-xs text-ink-500">
                        {s.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                      </TD>
                      <TD>
                        <Link
                          href={`/statements/${s.bankLine.statement.id}`}
                          className="text-ink-900 hover:underline"
                        >
                          line #{s.bankLine.lineNo}
                        </Link>
                        <div className="text-[11px] text-ink-500">
                          {s.bankLine.description.length > 36
                            ? s.bankLine.description.slice(0, 36) + "…"
                            : s.bankLine.description}
                        </div>
                      </TD>
                      <TD className="amount-cell text-right">
                        {formatMoney(s.bankLine.amount.toString())}
                      </TD>
                      <TD>
                        {accepted ? (
                          <Badge tone="positive">accepted</Badge>
                        ) : rejected ? (
                          <Badge tone="negative">rejected</Badge>
                        ) : (
                          <Badge tone="neutral">pending</Badge>
                        )}
                      </TD>
                      <TD className="text-xs">
                        {top ? (
                          <div>
                            <div className="text-ink-700">
                              conf {(top.confidence * 100).toFixed(0)}%
                            </div>
                            <div className="text-ink-500">
                              {top.rationale.length > 60
                                ? top.rationale.slice(0, 60) + "…"
                                : top.rationale}
                            </div>
                          </div>
                        ) : (
                          <span className="text-ink-400">no candidates</span>
                        )}
                      </TD>
                      <TD className="text-right text-xs text-ink-600">
                        {((s.promptTokens ?? 0) + (s.completionTokens ?? 0)).toLocaleString()}
                      </TD>
                      <TD className="text-right text-xs text-ink-600">
                        {s.latencyMs ? `${s.latencyMs}ms` : "—"}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="px-5 py-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
          {label}
        </div>
        <div className="mt-1 text-lg font-semibold text-ink-900">{value}</div>
        {hint ? <div className="mt-0.5 text-[11px] text-ink-500">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}
