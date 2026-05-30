// SOC 2 control helpers — the standing reference module every new
// feature should import from. Companion-repo slim version.
//
// The master copy lives at
//   /Users/hosungson/Code/ledger-core/src/lib/soc2/index.ts
// and additionally re-exports the audit-log writers (logAuditEvent
// + variants). Those aren't available here because companion repos
// emit audit rows by POSTing to ledger-core's internal endpoints
// rather than writing the table directly. The standalone helpers
// below are identical across all 5 repos in the portfolio.
//
// Companion artifacts:
//   - docs/SOC2_READINESS.md (in ledger-core) — gap analysis + ratings
//   - .claude/skills/soc2 — skill that surfaces this module to
//                          future Claude sessions automatically
//
// Usage discipline:
//   1. Every cross-tenant-risky read uses assertTenantScope after the
//      tenant-constrained query. (CC6)
//   2. Every cryptographic / token comparison uses constantTimeEqual.
//      Never `===`. (CC6)
//   3. Every log line that might include user-visible identifiers
//      runs through redactPii. (Confidentiality TSC)
//   4. Every error response sent to a client goes through
//      sanitizeError. Never raw .message + .stack. (CC7)

import { timingSafeEqual } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// CC6 — Multi-tenant scope assertion
// ─────────────────────────────────────────────────────────────────────────────

export class CrossTenantAccessError extends Error {
  constructor(resource: string) {
    super(
      `Cross-tenant access blocked: ${resource} belongs to another tenant.`
    );
    this.name = "CrossTenantAccessError";
  }
}

/**
 * Asserts the loaded row's tenantId matches the actor's tenant.
 * Throws CrossTenantAccessError on null OR tenant mismatch.
 *
 * Null and cross-tenant both raise the same error — distinguishing
 * "not found" from "in another tenant" would confirm record
 * existence to an attacker probing IDs across tenants.
 */
export function assertTenantScope<T extends { tenantId: string }>(
  row: T | null,
  actorTenantId: string,
  resourceLabel: string
): T {
  if (!row) throw new CrossTenantAccessError(resourceLabel);
  if (row.tenantId !== actorTenantId) {
    throw new CrossTenantAccessError(resourceLabel);
  }
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// CC6 — Constant-time string compare
// ─────────────────────────────────────────────────────────────────────────────

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidentiality TSC — PII redaction in logs
// ─────────────────────────────────────────────────────────────────────────────

const PII_FIELD_NAMES = new Set<string>([
  // Identity
  "email", "emailAddress", "displayName", "firstName", "lastName",
  "fullName", "phone", "phoneNumber", "address", "addressLine1",
  "addressLine2",
  // Financial
  "accountNumber", "routingNumber", "ssn", "taxId", "ein",
  // Auth
  "password", "token", "apiKey", "secret", "accessToken",
  "refreshToken", "sessionToken", "clerkUserId",
  // Customer payload
  "memo", "description", "notes",
]);

const REDACTED = "[REDACTED]";

export function redactPii<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactPii(item)) as unknown as T;
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (PII_FIELD_NAMES.has(k)) {
      result[k] = REDACTED;
    } else {
      result[k] = redactPii(v);
    }
  }
  return result as unknown as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// CC7 — Sanitized error response
// ─────────────────────────────────────────────────────────────────────────────

export interface SafeErrorResponse {
  code: string;
  message: string;
  correlationId?: string;
}

export function sanitizeError(
  err: unknown,
  hint: {
    code?: string;
    fallbackMessage?: string;
    correlationId?: string;
  } = {}
): SafeErrorResponse {
  const code = hint.code ?? deriveCode(err) ?? "INTERNAL_ERROR";
  let message: string;
  if (
    err instanceof Error &&
    code !== "INTERNAL_ERROR" &&
    err.message &&
    err.message.length < 200
  ) {
    message = err.message;
  } else {
    message =
      hint.fallbackMessage ??
      "An unexpected error occurred. Please try again or contact support.";
  }
  return {
    code,
    message,
    ...(hint.correlationId ? { correlationId: hint.correlationId } : {}),
  };
}

function deriveCode(err: unknown): string | undefined {
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  ) {
    return (err as { code: string }).code;
  }
  if (err instanceof CrossTenantAccessError) return "NOT_FOUND";
  return undefined;
}
