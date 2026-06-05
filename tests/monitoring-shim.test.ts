// Unit tests for the recon monitoring shim.
//
// Mirror of fa-amort's tests (fa-amort PR #21) with recon-specific
// PII fields (bank-line description, rawPayload, etc).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { redactPii, PII_FIELDS } from "../src/lib/soc2/redact-pii";
import {
  captureError,
  captureMessage,
} from "../src/lib/monitoring";

describe("redactPii — PII allowlist", () => {
  it("redacts every field in the canonical PII set", () => {
    const obj = {
      email: "alice@example.com",
      password: "hunter2",
      token: "tok_abc",
      apiKey: "key_xyz",
      accountNumber: "1234567890",
      bankName: "Acme Bank",
      description: "CHECK 123 PAID TO JANE DOE",
      rawPayload: { raw: "from bank API" },
      candidatesJson: { reasoning: "matched on amount" },
      benign: "value",
    };
    const out = redactPii(obj);
    expect(out.email).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.token).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.accountNumber).toBe("[REDACTED]");
    expect(out.bankName).toBe("[REDACTED]");
    expect(out.description).toBe("[REDACTED]");
    expect(out.rawPayload).toBe("[REDACTED]");
    expect(out.candidatesJson).toBe("[REDACTED]");
    // Non-PII field passes through.
    expect(out.benign).toBe("value");
  });

  it("does NOT mutate the input object", () => {
    const obj = { email: "x@y.com", benign: 1 };
    const out = redactPii(obj);
    expect(obj.email).toBe("x@y.com"); // input untouched
    expect(out.email).toBe("[REDACTED]");
  });

  it("traverses arrays of objects", () => {
    const arr = [{ email: "a@x.com" }, { email: "b@y.com" }];
    const out = redactPii(arr);
    expect(out[0].email).toBe("[REDACTED]");
    expect(out[1].email).toBe("[REDACTED]");
  });

  it("redacts nested PII deep inside an object tree", () => {
    const obj = {
      level1: { level2: { email: "buried@example.com", other: "ok" } },
    };
    const out = redactPii(obj);
    expect(out.level1.level2.email).toBe("[REDACTED]");
    expect(out.level1.level2.other).toBe("ok");
  });

  it("preserves null + undefined + primitives", () => {
    expect(redactPii(null)).toBe(null);
    expect(redactPii(undefined)).toBe(undefined);
    expect(redactPii("hello")).toBe("hello");
    expect(redactPii(42)).toBe(42);
    expect(redactPii(true)).toBe(true);
  });

  it("redacts Error.message but keeps name + stack", () => {
    const err = new Error("Failed for user alice@example.com");
    const out = redactPii(err);
    expect(out.name).toBe("Error");
    expect(out.message).toBe("[REDACTED]");
    expect(out.stack).toBeTruthy();
  });

  it("exports PII_FIELDS for audit trail", () => {
    expect(PII_FIELDS).toBeInstanceOf(Set);
    expect(PII_FIELDS.has("email")).toBe(true);
    expect(PII_FIELDS.has("rawPayload")).toBe(true);
    expect(PII_FIELDS.has("benign")).toBe(false);
  });
});

describe("captureError — Sentry fallback path", () => {
  const origDsn = process.env.SENTRY_DSN;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
    consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (origDsn) process.env.SENTRY_DSN = origDsn;
    consoleErrorSpy.mockRestore();
  });

  it("calls console.error with [monitoring] prefix when DSN absent", () => {
    captureError(new Error("boom"), { context: "test" });
    expect(consoleErrorSpy).toHaveBeenCalled();
    const args = consoleErrorSpy.mock.calls[0];
    expect(args[0]).toBe("[monitoring]");
  });

  it("does NOT pass raw err.message to console (bank-line description leak prevention)", () => {
    const err = new Error("Failed to insert CHECK 123 PAID TO JANE DOE");
    captureError(err, { context: "test" });
    const args = consoleErrorSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain("JANE DOE");
    expect(serialized).not.toContain("CHECK 123");
    expect(serialized).toContain("errName");
  });

  it("redacts PII from the extra context", () => {
    captureError(new Error("x"), {
      context: "test",
      extra: { email: "alice@example.com", accountNumber: "1234", benign: "value" },
    });
    const args = consoleErrorSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("1234");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("value");
  });

  it("passes through non-Error primitives as errPrimitive", () => {
    captureError("string-error", { context: "test" });
    const args = consoleErrorSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    expect(serialized).toContain("errPrimitive");
    expect(serialized).toContain("string-error");
  });
});

describe("captureMessage — level routing", () => {
  const origDsn = process.env.SENTRY_DSN;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (origDsn) process.env.SENTRY_DSN = origDsn;
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("info → console.log", () => {
    captureMessage("informational", "info");
    expect(consoleLogSpy).toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("warning → console.warn", () => {
    captureMessage("warn", "warning");
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it("error → console.error", () => {
    captureMessage("err", "error");
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
