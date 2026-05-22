// AI match suggester.
//
// Given a bank line and a list of candidate JE lines pre-filtered from
// ledger-core (typically: same cash account, ±N day window, amount-close),
// asks Claude to rank the candidates and return
// {journalLineId, confidence, rationale} for each.
//
// Design notes:
//
//   - Model: claude-haiku-4-5. This is a structured-output ranking task
//     over a small candidate set — Haiku is fast and cheap. Per recon's
//     CLAUDE.md, this is the project default (NOT the claude-api skill's
//     opus-4-7 default, which is reserved for reasoning-heavy work).
//
//   - Prompt caching: the system prompt (instructions) is wrapped in
//     `cache_control: {type: "ephemeral"}` so it's cached across many
//     invocations. The user message carries the volatile per-call payload
//     (this bank line + this candidate batch).
//
//   - Structured output: enforced via the forced tool-use pattern. We
//     declare a single tool `propose_matches` with the desired JSON
//     schema, then set `tool_choice: {type: "tool", name: "..."}` so the
//     model MUST call it. The tool's `input` is our structured payload.
//     This is the long-stable Anthropic structured-output convention and
//     doesn't depend on the newer messages.parse() API.
//
//   - The function is pure with respect to the database — the caller is
//     responsible for persisting the returned AiSuggestion row.
//
//   - The AI never sees data outside the {bankLine, candidates} payload.
//     No cross-entity / cross-period leakage by construction.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Decimal } from "decimal.js";
import { createHash } from "node:crypto";

export const AI_MATCH_MODEL = "claude-haiku-4-5";
const TOOL_NAME = "propose_matches";

// What the model returns. The schema is intentionally narrow — no
// free-form fields the model might fill with hallucinated context.
const AiCandidateSchema = z.object({
  journalLineId: z
    .string()
    .describe(
      "Must be one of the journalLineIds from the input candidates list. Do NOT invent IDs."
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "0..1 confidence that this JE line is the correct match for the bank line. 1.0 = certain match; 0.0 = certainly not."
    ),
  rationale: z
    .string()
    .max(280)
    .describe(
      "One short sentence (under 280 chars) explaining the match — what evidence supports it, or why it's weak."
    ),
});

const AiResponseSchema = z.object({
  candidates: z
    .array(AiCandidateSchema)
    .describe(
      "Ranked list in DESCENDING confidence order. May be empty if none of the inputs are plausible. Length must not exceed the number of input candidates."
    ),
});

export type AiCandidate = z.infer<typeof AiCandidateSchema>;
export type AiResponse = z.infer<typeof AiResponseSchema>;

// Inputs the caller assembles. Shape kept parallel to the deterministic
// scorer's MatchCandidateInput so the same fetch can feed both pipelines.
export interface AiBankLine {
  amount: Decimal;         // signed
  date: Date;
  description: string;
}

export interface AiCandidateInput {
  journalLineId: string;
  jeDebit: Decimal;
  jeCredit: Decimal;
  jeDate: Date;
  jeMemo: string;
  jePartyDisplayName?: string;
}

export interface AiSuggestionResult {
  candidates: AiCandidate[];
  modelName: string;
  promptHash: string;
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  latencyMs: number;
}

// Stable system prefix. Designed to be the first content the model sees
// on every recon call — high cache-hit rate across many bank lines.
//
// IMPORTANT: any change here invalidates the cache for every downstream
// invocation. Treat edits like a schema migration.
const SYSTEM_PROMPT = `You are a bookkeeping reconciliation assistant for a small-business accountant.

Your job is to look at a single bank statement line and a list of candidate journal-entry lines from the same general-ledger cash account, then return a ranked list of which JE lines most plausibly explain the bank line.

How to think about matches:

- AMOUNT is the dominant signal. A JE line that doesn't match the bank line's signed amount (deposit vs. withdrawal, exact value) is almost never the right match — give it confidence < 0.2 unless the rest of the evidence is overwhelming.
- DATE proximity matters but bank settlement often lags the booking date by 1–3 business days. Same-day is strongest; ±5 days is still plausible; further apart needs a strong reason.
- DESCRIPTION / COUNTERPARTY: bank descriptions are abbreviated, uppercase, and noisy ("ACH CR ACME CRP INV"). The JE memo and party name are clean. Look for token overlap, vendor-name fragments, invoice numbers, check numbers.
- WITHDRAWALS (negative bank amount) should correspond to JE lines that CREDIT the cash account. DEPOSITS (positive bank amount) should correspond to JE lines that DEBIT cash. The signed amount in the input already reflects this convention.

What to return — call the propose_matches tool exactly once with these arguments:

- A "candidates" array. Each entry is {journalLineId, confidence, rationale}.
- Order: DESCENDING by confidence.
- ONLY include candidates from the input list. Never invent a journalLineId. If none of the inputs are plausible, return an empty array.
- Be conservative with high confidence: reserve 0.85+ for matches where amount, date (±2 days), and either counterparty or memo all line up. Use 0.5–0.85 for plausible-but-incomplete evidence. Below 0.5 for "probably not, but worth flagging".
- Rationale: ONE short sentence per candidate, under 280 chars. State the evidence concretely — "exact amount, same day, ACME in both descriptions" — not vague claims like "looks like a match".

You are an advisor, not the system of record. A human reviews every suggestion before it touches the ledger.`;

// Format a single candidate for the user-message payload. Compact, one
// candidate per line — shorter payloads = lower per-call token cost.
function formatCandidate(c: AiCandidateInput): string {
  const signed = c.jeDebit.minus(c.jeCredit);
  const side = signed.isPositive() ? "DEBIT cash" : signed.isNegative() ? "CREDIT cash" : "ZERO";
  const party = c.jePartyDisplayName ? ` | party=${c.jePartyDisplayName}` : "";
  return `  - id=${c.journalLineId} | ${side} ${signed.abs().toFixed(2)} | date=${c.jeDate.toISOString().slice(0, 10)} | memo="${c.jeMemo}"${party}`;
}

function buildUserMessage(bankLine: AiBankLine, candidates: AiCandidateInput[]): string {
  const direction = bankLine.amount.isPositive()
    ? "DEPOSIT (inflow)"
    : bankLine.amount.isNegative()
      ? "WITHDRAWAL (outflow)"
      : "ZERO";
  return [
    `Bank line:`,
    `  amount=${bankLine.amount.toFixed(2)} (${direction})`,
    `  date=${bankLine.date.toISOString().slice(0, 10)}`,
    `  description="${bankLine.description}"`,
    ``,
    `Candidate JE lines (${candidates.length}):`,
    ...candidates.map(formatCandidate),
    ``,
    `Call propose_matches with the ranked candidates.`,
  ].join("\n");
}

// JSON Schema for the forced tool. Generated once at module load (the
// Zod schema is static).
const TOOL_JSON_SCHEMA = (() => {
  const full = zodToJsonSchema(AiResponseSchema, { target: "openApi3" }) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    type: "object" as const,
    properties: full.properties ?? {},
    required: full.required ?? [],
  };
})();

// Singleton client. Reads ANTHROPIC_API_KEY from the environment.
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

// Allow tests to inject a mock. Pass null to restore the env-backed client.
export function setClientForTesting(client: Anthropic | null): void {
  _client = client;
}

export async function getAiMatchSuggestions(
  bankLine: AiBankLine,
  candidates: AiCandidateInput[]
): Promise<AiSuggestionResult> {
  if (candidates.length === 0) {
    return {
      candidates: [],
      modelName: AI_MATCH_MODEL,
      promptHash: "",
      promptTokens: null,
      completionTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      latencyMs: 0,
    };
  }

  const userMessage = buildUserMessage(bankLine, candidates);
  const promptHash = createHash("sha256")
    .update(SYSTEM_PROMPT)
    .update("\n---\n")
    .update(userMessage)
    .digest("hex");

  const startedAt = Date.now();
  const response = await getClient().messages.create({
    model: AI_MATCH_MODEL,
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
    tools: [
      {
        name: TOOL_NAME,
        description: "Return the ranked candidate matches for this bank line.",
        input_schema: TOOL_JSON_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
  });
  const latencyMs = Date.now() - startedAt;

  // Pull the tool_use block. With forced tool_choice the model MUST emit
  // exactly one — but be defensive in case the API contract shifts.
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error(
      `AI suggester returned no tool_use block. stop_reason=${response.stop_reason}`
    );
  }

  const parsed = AiResponseSchema.parse(toolUse.input);

  // Defensive: drop any IDs the model invented despite the prompt. The
  // schema can't enforce membership in the candidates list, only post-
  // validation can.
  const validIds = new Set(candidates.map((c) => c.journalLineId));
  const safeCandidates = parsed.candidates.filter((c) => validIds.has(c.journalLineId));

  return {
    candidates: safeCandidates,
    modelName: AI_MATCH_MODEL,
    promptHash,
    promptTokens: response.usage?.input_tokens ?? null,
    completionTokens: response.usage?.output_tokens ?? null,
    cacheReadTokens: response.usage?.cache_read_input_tokens ?? null,
    cacheCreationTokens: response.usage?.cache_creation_input_tokens ?? null,
    latencyMs,
  };
}
