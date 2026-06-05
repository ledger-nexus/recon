// Contract tests for the DSR recon-attribution helper.
//
// These tests lock the INTERFACE shape — counts-only, no contents.
// Runtime-behavior tests (counts vs. real Postgres) live in
// `recon-attribution-integration.test.ts`.
//
// Before wiring: function threw NotImplementedError. After wiring:
// the function is wired but the contract shape is still enforced here.

import { describe, it, expect } from "vitest";
import {
  reconAttribution,
  NotImplementedError,
  type ReconAttribution,
} from "@/lib/privacy/recon-attribution";

describe("DSR — recon attribution contract (Privacy TSC)", () => {
  it("exports the reconAttribution function", () => {
    expect(typeof reconAttribution).toBe("function");
  });

  it("retains the NotImplementedError class export (back-compat)", () => {
    // Kept for callers that imported it during the typed-stub era.
    expect(typeof NotImplementedError).toBe("function");
    expect(new NotImplementedError("test").name).toBe("NotImplementedError");
  });

  it("ReconAttribution interface shape is stable (counts only, no contents)", () => {
    // Compile-time assertion via type satisfaction. If the interface
    // ever sprouts a "contents" / "details" / "rawData" field, this
    // test fails at tsc.
    const shape: ReconAttribution = {
      bankStatementsUploaded: 0,
      reconciliationMatchesApproved: 0,
      aiSuggestionsAccepted: 0,
      aiSuggestionsRejected: 0,
      snapshotAt: "2026-06-03T00:00:00.000Z",
    };
    expect(shape.bankStatementsUploaded).toBe(0);

    // Sanity: the keys we DO have don't contain content-shaped names.
    const keys = Object.keys(shape);
    const forbidden = ["contents", "details", "rawdata", "description", "memo"];
    for (const k of keys) {
      for (const f of forbidden) {
        expect(k.toLowerCase()).not.toContain(f.toLowerCase());
      }
    }
  });
});
