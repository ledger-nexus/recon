// Tests for the AI match suggester. Uses an injected mock Anthropic
// client so no live API calls happen. Verifies:
//
//   - The forced tool-use round-trip is parsed into AiCandidate shape.
//   - Hallucinated journalLineIds (not in the input list) are filtered.
//   - Empty candidate input short-circuits — no API call.
//   - System prompt carries `cache_control` (prompt caching is wired).
//   - The user message contains amount + date + description.

import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import {
  getAiMatchSuggestions,
  setClientForTesting,
  AI_MATCH_MODEL,
  type AiCandidateInput,
} from "../src/lib/matching/ai-suggest";

// Minimal stand-in for the Anthropic client surface we use.
function makeMockClient(
  toolInput: unknown,
  capture: { lastArgs?: Record<string, unknown> } = {}
) {
  return {
    messages: {
      create: async (args: Record<string, unknown>) => {
        capture.lastArgs = args;
        return {
          content: [{ type: "tool_use", name: "propose_matches", input: toolInput }],
          stop_reason: "tool_use",
          usage: {
            input_tokens: 1500,
            output_tokens: 200,
            cache_creation_input_tokens: 1200,
            cache_read_input_tokens: 0,
          },
        };
      },
    },
    // The SDK constructor is otherwise unused in our code path.
  } as unknown as Parameters<typeof setClientForTesting>[0];
}

const bankLine = {
  amount: new Decimal(5_000),
  date: new Date("2026-03-15"),
  description: "ACH CREDIT — ACME CORP",
};

const candidates: AiCandidateInput[] = [
  {
    journalLineId: "je-1",
    jeDebit: new Decimal(5_000),
    jeCredit: new Decimal(0),
    jeDate: new Date("2026-03-15"),
    jeMemo: "Acme Corp pays February invoice",
    jePartyDisplayName: "Acme Corp",
  },
  {
    journalLineId: "je-2",
    jeDebit: new Decimal(5_000),
    jeCredit: new Decimal(0),
    jeDate: new Date("2026-03-13"),
    jeMemo: "Unrelated deposit",
  },
];

beforeEach(() => {
  setClientForTesting(null);
});

describe("getAiMatchSuggestions", () => {
  it("parses a forced-tool response into typed candidates", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(
      makeMockClient(
        {
          candidates: [
            { journalLineId: "je-1", confidence: 0.95, rationale: "Exact, same day, name match" },
            { journalLineId: "je-2", confidence: 0.4, rationale: "Right amount, wrong story" },
          ],
        },
        capture
      )
    );

    const r = await getAiMatchSuggestions(bankLine, candidates);

    expect(r.modelName).toBe(AI_MATCH_MODEL);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0].journalLineId).toBe("je-1");
    expect(r.candidates[0].confidence).toBeCloseTo(0.95);
    expect(r.promptTokens).toBe(1500);
    expect(r.cacheCreationTokens).toBe(1200);
  });

  it("filters out hallucinated journalLineIds not in the input list", async () => {
    setClientForTesting(
      makeMockClient({
        candidates: [
          { journalLineId: "je-1", confidence: 0.9, rationale: "Real match" },
          { journalLineId: "made-up-id-99", confidence: 0.8, rationale: "Hallucinated" },
        ],
      })
    );

    const r = await getAiMatchSuggestions(bankLine, candidates);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].journalLineId).toBe("je-1");
  });

  it("short-circuits with no API call when candidates is empty", async () => {
    let called = false;
    setClientForTesting({
      messages: {
        create: async () => {
          called = true;
          throw new Error("should not be called");
        },
      },
    } as unknown as Parameters<typeof setClientForTesting>[0]);

    const r = await getAiMatchSuggestions(bankLine, []);
    expect(called).toBe(false);
    expect(r.candidates).toEqual([]);
  });

  it("sends a cache_control on the system prompt", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(makeMockClient({ candidates: [] }, capture));

    await getAiMatchSuggestions(bankLine, candidates);
    const system = capture.lastArgs?.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("includes the bank line amount, date, and description in the user message", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(makeMockClient({ candidates: [] }, capture));

    await getAiMatchSuggestions(bankLine, candidates);
    const messages = capture.lastArgs?.messages as Array<{ role: string; content: string }>;
    const userContent = messages[0].content;
    expect(userContent).toContain("5000.00");
    expect(userContent).toContain("2026-03-15");
    expect(userContent).toContain("ACME CORP");
    expect(userContent).toContain("je-1");
    expect(userContent).toContain("je-2");
  });

  it("throws when the model returns no tool_use block", async () => {
    setClientForTesting({
      messages: {
        create: async () => ({
          content: [{ type: "text", text: "I refuse" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      },
    } as unknown as Parameters<typeof setClientForTesting>[0]);

    await expect(getAiMatchSuggestions(bankLine, candidates)).rejects.toThrow(/tool_use/);
  });
});
