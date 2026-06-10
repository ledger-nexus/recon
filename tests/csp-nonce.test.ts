// Tests for the CSP nonce + header construction. Pure function
// coverage — the full middleware integration runs in the next.config
// header-application path which isn't unit-testable.

import { describe, it, expect } from "vitest";
import { _internal } from "../src/middleware";

const { generateNonce, buildCspHeader } = _internal;

describe("CSP nonce (CC6.6 — anti-XSS)", () => {
  it("generates a 22-char base64url nonce (16 random bytes)", () => {
    const n = generateNonce();
    // base64url of 16 bytes = 22 chars, padding stripped.
    expect(n).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("returns a different nonce on every call", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 100; i++) nonces.add(generateNonce());
    expect(nonces.size).toBe(100);
  });
});

describe("CSP header (CC6.6 — content security policy)", () => {
  const NONCE = "ABCDEFGHIJKLMNOPQRSTUV";

  it("includes the nonce inside script-src 'nonce-...' 'strict-dynamic'", () => {
    const csp = buildCspHeader(NONCE);
    expect(csp).toContain(`script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`);
  });

  it("blocks framing (frame-ancestors none) — defense in depth with X-Frame-Options DENY", () => {
    const csp = buildCspHeader(NONCE);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("blocks plugin loading (object-src none)", () => {
    const csp = buildCspHeader(NONCE);
    expect(csp).toContain("object-src 'none'");
  });

  it("forces HTTPS upgrade for any mixed-content fallback", () => {
    const csp = buildCspHeader(NONCE);
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("allows Clerk + Sentry + Stripe via connect-src", () => {
    const csp = buildCspHeader(NONCE);
    expect(csp).toContain("https://*.clerk.com");
    expect(csp).toContain("https://*.sentry.io");
    expect(csp).toContain("https://api.stripe.com");
  });

  it("allows Clerk + Stripe iframes (sign-in widget + payment elements)", () => {
    const csp = buildCspHeader(NONCE);
    expect(csp).toContain("frame-src https://*.clerk.com");
    expect(csp).toContain("https://js.stripe.com");
  });

  it("policy is delimited with `; ` and parseable", () => {
    const csp = buildCspHeader(NONCE);
    // Should not contain double semicolons or trailing whitespace.
    expect(csp).not.toMatch(/;;/);
    expect(csp).not.toMatch(/;\s*$/);
    // Each directive should have at least one source value.
    const parts = csp.split("; ");
    for (const part of parts) {
      expect(part.trim().length).toBeGreaterThan(0);
    }
  });
});
