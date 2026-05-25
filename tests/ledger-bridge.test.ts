// Tests for the ledger-core HTTP bridge. Uses an injected mock fetch so
// no real network calls happen. Verifies:
//
//   - Successful round-trip returns {id, entryNumber, bookCode}
//   - Ledger-core error responses become LedgerCoreError with the right code
//   - Transport failures (fetch throws, non-JSON body) raise TRANSPORT_ERROR
//   - Missing LEDGER_CORE_INTERNAL_TOKEN raises UNAUTHORIZED
//   - Decimal serialization uses fixed-precision strings (not numbers)
//   - Auth header + body shape match the contract

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Decimal } from "decimal.js";
import {
  postEntryViaLedgerCore,
  setFetchForTesting,
  LedgerCoreError,
  type LedgerJournalEntryInput,
} from "../src/lib/ledger-bridge";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const baseInput: LedgerJournalEntryInput = {
  entityCode: "NORTHWIND",
  documentDate: new Date("2026-03-15"),
  memo: "Test adjustment",
  source: "MANUAL",
  lines: [
    { accountCode: "1000", credit: new Decimal("50.00") },
    { accountCode: "6500", debit: new Decimal("50.00") },
  ],
};

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.LEDGER_CORE_INTERNAL_TOKEN = "test-token-secret";
  process.env.LEDGER_CORE_URL = "http://test-ledger:3000";
  setFetchForTesting(null);
});

afterEach(() => {
  process.env = { ...originalEnv };
  setFetchForTesting(null);
});

describe("postEntryViaLedgerCore", () => {
  it("returns the parsed result on a successful 200", async () => {
    setFetchForTesting(async () =>
      jsonResponse({
        ok: true,
        id: "uuid-1",
        entryNumber: "NORTHWIND-US_GAAP-00042",
        bookCode: "US_GAAP",
      })
    );
    const r = await postEntryViaLedgerCore(baseInput);
    expect(r.id).toBe("uuid-1");
    expect(r.entryNumber).toBe("NORTHWIND-US_GAAP-00042");
    expect(r.bookCode).toBe("US_GAAP");
  });

  it("sends auth header and a JSON body matching the wire contract", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    setFetchForTesting(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return jsonResponse({
        ok: true,
        id: "x",
        entryNumber: "x",
        bookCode: "US_GAAP",
      });
    });
    await postEntryViaLedgerCore(baseInput);
    expect(capturedUrl).toBe("http://test-ledger:3000/api/internal/journal-entries");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token-secret");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.entityCode).toBe("NORTHWIND");
    expect(body.memo).toBe("Test adjustment");
    expect(body.source).toBe("MANUAL");
    // Decimals must be serialized as strings (not numbers).
    expect(body.lines[0].credit).toBe("50");
    expect(typeof body.lines[0].credit).toBe("string");
    // documentDate must be an ISO string.
    expect(body.documentDate).toMatch(/^2026-03-15T/);
  });

  it("raises LedgerCoreError with the right code on UNBALANCED response", async () => {
    setFetchForTesting(async () =>
      jsonResponse(
        {
          ok: false,
          error: { code: "UNBALANCED", message: "debits 50.00 ≠ credits 51.00" },
        },
        422
      )
    );
    await expect(postEntryViaLedgerCore(baseInput)).rejects.toMatchObject({
      name: "LedgerCoreError",
      code: "UNBALANCED",
      status: 422,
    });
  });

  it("raises LedgerCoreError with PERIOD_CLOSED on 409", async () => {
    setFetchForTesting(async () =>
      jsonResponse(
        {
          ok: false,
          error: { code: "PERIOD_CLOSED", message: "Period 2026-03 is closed" },
        },
        409
      )
    );
    await expect(postEntryViaLedgerCore(baseInput)).rejects.toMatchObject({
      code: "PERIOD_CLOSED",
    });
  });

  it("raises TRANSPORT_ERROR when fetch throws", async () => {
    setFetchForTesting(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(postEntryViaLedgerCore(baseInput)).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
  });

  it("raises TRANSPORT_ERROR when the response body is not JSON", async () => {
    setFetchForTesting(
      async () =>
        new Response("<html>500 server error</html>", {
          status: 500,
          headers: { "Content-Type": "text/html" },
        })
    );
    await expect(postEntryViaLedgerCore(baseInput)).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
      status: 500,
    });
  });

  it("raises UNAUTHORIZED LedgerCoreError when token is missing", async () => {
    delete process.env.LEDGER_CORE_INTERNAL_TOKEN;
    let called = false;
    setFetchForTesting(async () => {
      called = true;
      return jsonResponse({ ok: true, id: "x", entryNumber: "x", bookCode: "x" });
    });
    await expect(postEntryViaLedgerCore(baseInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(called).toBe(false);
  });

  it("LedgerCoreError instances are recognizable via instanceof", async () => {
    setFetchForTesting(async () =>
      jsonResponse({ ok: false, error: { code: "UNKNOWN_ACCOUNT", message: "x" } }, 422)
    );
    try {
      await postEntryViaLedgerCore(baseInput);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LedgerCoreError);
    }
  });

  it("surfaces INVALID_LINE from ledger-core with status preserved", async () => {
    setFetchForTesting(async () =>
      jsonResponse(
        { ok: false, error: { code: "INVALID_LINE", message: "line 2 missing accountCode" } },
        422
      )
    );
    await expect(postEntryViaLedgerCore(baseInput)).rejects.toMatchObject({
      name: "LedgerCoreError",
      code: "INVALID_LINE",
      status: 422,
    });
  });

  it("forwards optional bookCode + sourceSystem fields in the request body", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    setFetchForTesting(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return jsonResponse({
        ok: true,
        id: "x",
        entryNumber: "x",
        bookCode: "MGMT",
      });
    });
    await postEntryViaLedgerCore({
      ...baseInput,
      bookCode: "MGMT",
      sourceSystem: "RECON",
      sourceRecordType: "BANK_LINE",
      sourceRecordId: "stmt-1:line-3",
    });
    expect(capturedBody?.bookCode).toBe("MGMT");
    expect(capturedBody?.sourceSystem).toBe("RECON");
    expect(capturedBody?.sourceRecordType).toBe("BANK_LINE");
    expect(capturedBody?.sourceRecordId).toBe("stmt-1:line-3");
  });

  it("falls back to the default ledger-core URL when LEDGER_CORE_URL is unset", async () => {
    delete process.env.LEDGER_CORE_URL;
    let capturedUrl = "";
    setFetchForTesting(async (url) => {
      capturedUrl = String(url);
      return jsonResponse({ ok: true, id: "x", entryNumber: "x", bookCode: "US_GAAP" });
    });
    await postEntryViaLedgerCore(baseInput);
    // The default is http://localhost:3000 (ledger-core's dev port).
    expect(capturedUrl).toBe("http://localhost:3000/api/internal/journal-entries");
  });
});
