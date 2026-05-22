# AI matching (v0.2)

How recon turns "an unmatched bank line" into "a human-approved link to a journal entry," with Claude in the loop but never on the critical write path.

## The pipeline, end to end

```
┌─────────────────────────────────────────────────────────────────────┐
│ Bank statement uploaded → BankStatementLine rows in UNMATCHED state │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                  user clicks "Suggest matches" on a line
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ proposeMatchesAction(bankLineId)  [server action]                   │
│   1. fetchCandidateJournalLines  — read-only into ledger-core       │
│   2. rankCandidates              — deterministic scorer             │
│   3. if top score < 0.85:        — call AI suggester                │
│        getAiMatchSuggestions     — Claude Haiku 4.5, prompt-cached  │
│        persist AiSuggestion row  — audit ALL runs                   │
│   4. create PROPOSED ReconciliationMatch rows (cap = 3)             │
│   5. flip bank line to PROPOSED                                     │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                          UI re-renders, shows
                          ranked proposal cards
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ user clicks Approve or Reject on one proposal                       │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ approveMatchAction(matchId)                                         │
│   - match → APPROVED                                                │
│   - sibling PROPOSED matches → WITHDRAWN                            │
│   - bank line → MATCHED                                             │
│   - statement counters updated                                      │
│                                                                     │
│ rejectMatchAction(matchId)                                          │
│   - match → REJECTED                                                │
│   - if no PROPOSED remain on this line, line → UNMATCHED            │
└─────────────────────────────────────────────────────────────────────┘
```

**Nowhere in this pipeline does AI output flow into a ledger write.** Adjustment JEs (the path that calls `postJournalEntry` with `source: "AI_APPROVED"`) ship in v0.2-beta and are gated on the same approval action.

## Why deterministic first, AI second

The deterministic scorer (`src/lib/matching/deterministic.ts`) handles the easy cases: exact amount, same day, vendor name in the description. That's the long tail of clean ACH credits, payroll runs, and well-coded vendor payments. It's fast, free, and explainable.

The AI is the second line of defense for the messy cases:

- Bank descriptions like `ACH CR ACME CRP INV-0421` where the parser can't find vendor tokens but a model recognizes "ACME CRP" maps to "Acme Corporation"
- Timing skew (bank settles 2–3 business days after booking) where the deterministic date score has decayed but the rest of the evidence is strong
- Memo nuance ("legal retainer Q1 partial" vs "Q1 legal — Smith & Co partial payment") where token overlap is low but semantic match is high

If the deterministic top score is already ≥ 0.85 (`AUTO_PROPOSE_THRESHOLD`), recon skips the AI call entirely. Cheaper, faster, and the deterministic match is good enough.

## Why Claude Haiku 4.5

Matching is a **structured-output ranking task over a small candidate set**, not deep reasoning. Per recon's CLAUDE.md, the project default is `claude-haiku-4-5`:

- Fast (~700ms typical for our prompt shape)
- Cheap (the cache reads dominate per-call cost after the first invocation in a 5-minute window)
- Structured-output reliable when given a forced tool schema

The `claude-api` skill's default of `claude-opus-4-7` is reserved for the reasoning-heavy paths we don't have yet (e.g. classifying ambiguous adjustments, drafting accounting memos). Don't pick Opus for this just because it's "smarter" — the marginal accuracy gain isn't worth the 10x latency hit when humans are reviewing every suggestion anyway.

## Prompt caching

The system prompt in `ai-suggest.ts` is wrapped in `cache_control: { type: "ephemeral" }`. The stable parts (instructions + heuristic rules + output schema explanation) cache across many bank lines. The volatile parts (this specific bank line + this candidate list) go in the user message and are NEVER cached.

**Cache hit verification**: every AI run logs `cache_read_input_tokens` and `cache_creation_input_tokens` from the response's `usage` field. The first call in a 5-minute window pays the create cost; subsequent calls within the TTL pay only the read cost. The `AiSuggestion.promptHash` field (SHA-256 over system + user) makes it trivial to check whether two runs had identical prompts (they shouldn't — the user message varies — but the system half should consistently hit).

**Caching pitfall to avoid**: the cache key is the prefix up to the `cache_control` breakpoint. ANY byte change in `SYSTEM_PROMPT` invalidates every downstream cache. Treat edits to that string like a schema migration — bunch up wording tweaks, ship them together, don't churn it line by line.

## Structured output: forced tool use

The Anthropic SDK at 0.65 doesn't yet expose `messages.parse()` / `output_config` / `zodOutputFormat` in the published TypeScript build. Instead, we use the long-stable **forced tool-use** pattern:

1. Declare a single tool `propose_matches` with a JSON Schema derived from our Zod schema via `zod-to-json-schema`.
2. Set `tool_choice: { type: "tool", name: "propose_matches" }` so the model MUST call it.
3. Extract the `tool_use` block from `response.content`.
4. Validate the block's `input` against the Zod schema (`AiResponseSchema.parse`).
5. Defensive filter: drop any returned `journalLineId` that wasn't in the input candidates (schema can't enforce membership; the model occasionally invents IDs under load).

When the SDK ships a stable `messages.parse()` we'll migrate. The behavior contract from the caller's POV stays the same.

## Audit: AiSuggestion is sacred

Every AI run lands in `AiSuggestion`, **including runs where the model returned an empty candidates array.** The table is the answer to "did the AI actually help us?" — without it, you can't tell whether the model is contributing signal or just running up token bills.

Fields worth knowing about:

- `candidatesJson` — the full ranked response, even rejected ones. If a human rejects a 0.92-confidence suggestion that turned out to be correct, you want to find that.
- `promptHash` — for cache-hit analytics. Group by hash, count cache reads.
- `promptTokens` / `completionTokens` / `latencyMs` — straightforward cost telemetry.
- `modelName` — locked to whatever was current at run time. When we move off Haiku 4.5 we keep the history for A/B comparison.

## Failure modes and what they look like

| Failure | Symptom | Handling |
|---|---|---|
| Anthropic API down / 5xx | `proposeMatchesAction` logs the error, falls back to deterministic-only proposal | Non-fatal — UI still shows the deterministic top match if `score > 0` |
| Model hallucinates a journalLineId | Filtered post-parse via the validIds set | Logged in `AiSuggestion.candidatesJson` (raw) but excluded from `ReconciliationMatch` rows |
| Model returns no candidates (empty array) | `AiSuggestion` row still written, no PROPOSED matches created | UI shows "No proposals met the threshold" |
| Zod parse fails on the tool input | Throws — Server Action returns `{ok: false, message}` | Operator sees the error in the line's action area, can retry |
| No `ANTHROPIC_API_KEY` in env | SDK throws on client construction | Same as above — visible per-line failure rather than silent fallback |

## What recon never does with AI

- AI never calls `postJournalEntry` directly or indirectly.
- AI never sees data outside the `{bankLine, candidates}` payload — no cross-entity, cross-period, or cross-book leakage.
- AI never decides the final match status. The model returns a confidence and a rationale; only a human click flips a match to APPROVED.
- AI's confidence number is never used as a hidden gate. The only AI-confidence threshold in code is `AI_PROPOSE_THRESHOLD = 0.6` for whether to surface the suggestion in the UI at all — and the human still has to click Approve.
