// Smoke tests for GET /api/health.
//
// Verifies the response shape (status / db / monitoring / encryption /
// schemaFingerprint), key handling (NEVER exposes the encryption key
// itself, only a boolean), and the encryption column-count surface.
//
// Targeted at the `encryption` block added in the SOC 2 hardening
// rollout: operators rely on `curl /api/health | jq '.encryption'` to
// verify FIELD_ENCRYPTION_KEY landed in Vercel env — that contract
// must not regress.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET } from "@/app/api/health/route";

describe("GET /api/health: encryption block (Confidentiality TSC)", () => {
  const savedKey = process.env.FIELD_ENCRYPTION_KEY;

  beforeEach(() => {
    delete process.env.FIELD_ENCRYPTION_KEY;
  });
  afterEach(() => {
    if (savedKey !== undefined) process.env.FIELD_ENCRYPTION_KEY = savedKey;
    else delete process.env.FIELD_ENCRYPTION_KEY;
  });

  it("reports configured=false when FIELD_ENCRYPTION_KEY is unset", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.encryption).toBeDefined();
    expect(body.encryption.configured).toBe(false);
    expect(typeof body.encryption.columnCount).toBe("number");
    expect(body.encryption.columnCount).toBeGreaterThan(0);
  });

  it("reports configured=false when the key is the wrong length", async () => {
    process.env.FIELD_ENCRYPTION_KEY = "abc123"; // too short
    const res = await GET();
    const body = await res.json();
    expect(body.encryption.configured).toBe(false);
  });

  it("reports configured=false when the key contains non-hex chars", async () => {
    process.env.FIELD_ENCRYPTION_KEY = "z".repeat(64); // 64 chars, not hex
    const res = await GET();
    const body = await res.json();
    expect(body.encryption.configured).toBe(false);
  });

  it("reports configured=true with a valid 64-hex key", async () => {
    process.env.FIELD_ENCRYPTION_KEY = "a".repeat(64); // 64 hex chars
    const res = await GET();
    const body = await res.json();
    expect(body.encryption.configured).toBe(true);
  });

  it("NEVER exposes the key value, its substring, or any hash of it", async () => {
    const secret = "deadbeef".repeat(8); // 64 hex chars
    process.env.FIELD_ENCRYPTION_KEY = secret;
    const res = await GET();
    const bodyText = await res.text();
    expect(bodyText).not.toContain(secret);
    // Also reject any 8-char substring of the key showing up.
    expect(bodyText).not.toContain("deadbeef");
    expect(bodyText).not.toContain("eadbeefd"); // sliding window
    // And no recognizable hex blob of meaningful length.
    expect(bodyText).not.toMatch(/[0-9a-f]{32,}/);
  });

  it("response carries the no-store cache header (probe must always be fresh)", async () => {
    const res = await GET();
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("no-store");
  });

  it("response includes the expected top-level keys", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("schemaFingerprint");
    expect(body).toHaveProperty("db");
    expect(body).toHaveProperty("monitoring");
    expect(body).toHaveProperty("encryption");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("timestamp");
  });
});
