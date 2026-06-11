// Test for the DSR attribution stub.
//
// What this proves:
//   1. The stub function is exported (module path stable for the
//      future cross-repo HTTP endpoint that wraps it).
//   2. Calling the stub throws NotImplementedError, not silently
//      returns undefined / zero. Future implementers can't
//      accidentally no-op the throw without this test failing.
//   3. The interface shape is in scope (compile-time check via the
//      type import below).
//
// Why this matters: the DSR procedure
// (docs/policies/data-subject-requests.md) PROMISES the auditor that
// the wiring point exists. This test enforces the promise at the
// code level.

import { describe, it, expect } from "vitest";
import {
  reconAttribution,
  NotImplementedError,
  type ReconAttribution,
} from "@/lib/privacy/recon-attribution";

describe("DSR — recon attribution stub (Privacy TSC contract)", () => {
  it("exports the reconAttribution function", () => {
    expect(typeof reconAttribution).toBe("function");
  });

  it("exports the NotImplementedError class", () => {
    expect(typeof NotImplementedError).toBe("function");
    expect(new NotImplementedError("test").name).toBe("NotImplementedError");
  });

  it("throws NotImplementedError when called (locks the contract for future implementers)", async () => {
    // We don't need a real prisma — the stub throws before touching it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakePrisma = {} as any;
    await expect(reconAttribution(fakePrisma, "test-user-id")).rejects.toThrow(
      NotImplementedError
    );
  });

  it("error message points at the DSR doc's Open items section", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakePrisma = {} as any;
    try {
      await reconAttribution(fakePrisma, "test-user-id");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toMatch(/data-subject-requests/);
      expect((e as Error).message).toMatch(/Open items/);
    }
  });

  it("ReconAttribution interface shape is stable (counts only, no contents)", () => {
    // Compile-time assertion via type satisfaction. If the interface
    // ever sprouts a "contents" field, this test fails at tsc.
    const shape: ReconAttribution = {
      bankStatementsUploaded: 0,
      reconciliationMatchesApproved: 0,
      aiSuggestionsAccepted: 0,
      aiSuggestionsRejected: 0,
      snapshotAt: "2026-06-03T00:00:00.000Z",
    };
    expect(shape.bankStatementsUploaded).toBe(0);
  });
});
