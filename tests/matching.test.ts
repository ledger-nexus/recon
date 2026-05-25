// Deterministic match scorer unit tests. No DB needed.

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  scoreCandidate,
  rankCandidates,
  AUTO_PROPOSE_THRESHOLD,
} from "../src/lib/matching/deterministic";

describe("scoreCandidate", () => {
  it("exact amount + same day + party hit → score above auto-propose threshold", () => {
    const r = scoreCandidate({
      bankAmount: new Decimal(5_000),
      bankDate: new Date("2026-03-15"),
      bankDescription: "ACH CREDIT — ACME CORP INV-FEB",
      journalLineId: "x",
      jeDebit: new Decimal(5_000),
      jeCredit: new Decimal(0),
      jeDate: new Date("2026-03-15"),
      jeMemo: "Acme Corp pays February invoice",
      jePartyDisplayName: "Acme Corp",
    });
    expect(r.components.amountScore).toBe(1);
    expect(r.components.dateScore).toBe(1);
    expect(r.score).toBeGreaterThanOrEqual(AUTO_PROPOSE_THRESHOLD);
  });

  it("wrong amount → score = 0 regardless of date / description match", () => {
    const r = scoreCandidate({
      bankAmount: new Decimal(5_000),
      bankDate: new Date("2026-03-15"),
      bankDescription: "ACH CREDIT — ACME CORP",
      journalLineId: "x",
      jeDebit: new Decimal(4_999),
      jeCredit: new Decimal(0),
      jeDate: new Date("2026-03-15"),
      jeMemo: "Acme Corp pays February invoice",
      jePartyDisplayName: "Acme Corp",
    });
    expect(r.score).toBe(0);
  });

  it("matches a bank withdrawal (negative) against a JE credit on cash", () => {
    // Vendor payment: cash goes out, so JE credits cash (1000).
    // Bank line: negative amount.
    const r = scoreCandidate({
      bankAmount: new Decimal(-8_500),
      bankDate: new Date("2026-05-10"),
      bankDescription: "WIRE OUT — SMITH CO LEGAL",
      journalLineId: "x",
      jeDebit: new Decimal(0),
      jeCredit: new Decimal(8_500),
      jeDate: new Date("2026-05-10"),
      jeMemo: "Smith & Co — pay legal invoice",
      jePartyDisplayName: "Smith & Co Legal",
    });
    expect(r.components.amountScore).toBe(1);
  });

  it("date proximity degrades scores smoothly", () => {
    const baseInput = {
      bankAmount: new Decimal(100),
      bankDescription: "test",
      journalLineId: "x",
      jeDebit: new Decimal(100),
      jeCredit: new Decimal(0),
      jeMemo: "test",
    };
    const sameDay = scoreCandidate({
      ...baseInput,
      bankDate: new Date("2026-03-15"),
      jeDate: new Date("2026-03-15"),
    });
    const oneDay = scoreCandidate({
      ...baseInput,
      bankDate: new Date("2026-03-15"),
      jeDate: new Date("2026-03-16"),
    });
    const fiveDays = scoreCandidate({
      ...baseInput,
      bankDate: new Date("2026-03-15"),
      jeDate: new Date("2026-03-20"),
    });
    const sixDays = scoreCandidate({
      ...baseInput,
      bankDate: new Date("2026-03-15"),
      jeDate: new Date("2026-03-21"),
    });

    expect(sameDay.score).toBeGreaterThan(oneDay.score);
    expect(oneDay.score).toBeGreaterThan(fiveDays.score);
    expect(sixDays.components.dateScore).toBe(0);
  });
});

describe("rankCandidates", () => {
  it("returns candidates in descending score order", () => {
    const ranked = rankCandidates(
      { amount: new Decimal(5_000), date: new Date("2026-03-15"), description: "ACME CORP" },
      [
        {
          journalLineId: "wrong-amount",
          jeDebit: new Decimal(4_000),
          jeCredit: new Decimal(0),
          jeDate: new Date("2026-03-15"),
          jeMemo: "Acme bill",
        },
        {
          journalLineId: "exact",
          jeDebit: new Decimal(5_000),
          jeCredit: new Decimal(0),
          jeDate: new Date("2026-03-15"),
          jeMemo: "Acme invoice",
          jePartyDisplayName: "Acme Corp",
        },
        {
          journalLineId: "close-date",
          jeDebit: new Decimal(5_000),
          jeCredit: new Decimal(0),
          jeDate: new Date("2026-03-12"),
          jeMemo: "unrelated",
        },
      ]
    );
    expect(ranked[0].journalLineId).toBe("exact");
    expect(ranked[1].journalLineId).toBe("close-date");
    expect(ranked[2].journalLineId).toBe("wrong-amount");
    expect(ranked[2].score).toBe(0);
  });

  it("returns an empty array when no candidates are passed", () => {
    const ranked = rankCandidates(
      { amount: new Decimal(100), date: new Date("2026-03-15"), description: "foo" },
      []
    );
    expect(ranked).toEqual([]);
  });
});

describe("scoreCandidate: sign + token edges", () => {
  it("rejects a sign-flipped match (bank withdrawal vs JE debit) on amount", () => {
    // Sign discipline: a -$100 bank line should NOT match a +$100 JE debit
    // (debit-on-cash means money came IN, but the bank says it went out).
    // amountScore must be 0 so the weighted score collapses to 0.
    const r = scoreCandidate({
      bankAmount: new Decimal(-100),
      bankDate: new Date("2026-03-15"),
      bankDescription: "FEE",
      journalLineId: "x",
      jeDebit: new Decimal(100),
      jeCredit: new Decimal(0),
      jeDate: new Date("2026-03-15"),
      jeMemo: "FEE",
    });
    expect(r.components.amountScore).toBe(0);
    expect(r.score).toBe(0);
    expect(r.rationale).toMatch(/Amount mismatch/);
  });

  it("scores party-display-name overlap even when the memo has no shared tokens", () => {
    // Bank desc references the counterparty by name; the JE memo is
    // boilerplate ("AR invoice paid") with no overlapping tokens. The
    // party.displayName has to carry the description score.
    const r = scoreCandidate({
      bankAmount: new Decimal(2_500),
      bankDate: new Date("2026-03-15"),
      bankDescription: "ACH CREDIT GLOBEX",
      journalLineId: "x",
      jeDebit: new Decimal(2_500),
      jeCredit: new Decimal(0),
      jeDate: new Date("2026-03-15"),
      jeMemo: "invoice paid",
      jePartyDisplayName: "Globex",
    });
    expect(r.components.descriptionScore).toBeGreaterThan(0);
  });

  it("ignores sub-3-char tokens when scoring description overlap", () => {
    // Tokens "TO" and "AC" are both <3 chars and get filtered. Even though
    // both sides share every visible word, descriptionScore must be 0.
    const r = scoreCandidate({
      bankAmount: new Decimal(100),
      bankDate: new Date("2026-03-15"),
      bankDescription: "TO AC",
      journalLineId: "x",
      jeDebit: new Decimal(100),
      jeCredit: new Decimal(0),
      jeDate: new Date("2026-03-15"),
      jeMemo: "TO AC",
    });
    expect(r.components.descriptionScore).toBe(0);
  });
});
