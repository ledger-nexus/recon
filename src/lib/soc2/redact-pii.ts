// PII redaction helper — Confidentiality TSC + CC7.3 (security event
// evaluation: errors shipped to monitoring must not contain PII).
//
// Why this exists:
//   Server Actions and the load-bearing bank-recon flow regularly
//   embed parameter values in error messages or context objects.
//   When those errors flow to Sentry / Vercel logs, the embedded
//   values (bank-statement line descriptions, counterparty names,
//   account numbers) can contain PII. SOC 2 Confidentiality TSC
//   explicitly calls out that monitoring exhaust is a leak vector.
//
// What it does:
//   `redactPii(value)` deep-clones the value and masks any property
//   whose name appears in the PII_FIELD_NAMES allowlist. Arrays are
//   traversed. Strings/numbers/null pass through unchanged.
//
// Discipline:
//   Conservative is correct — over-redaction is acceptable;
//   under-redaction is a SOC 2 finding. Add to the allowlist when a
//   new sensitive column lands; never remove an entry without a
//   coordinated schema audit.
//
// Mirror of ledger-core's `src/lib/soc2/index.ts` redactPii (PR #10)
// + fa-amort's port (PR #21). recon-specific additions: bank line
// description (encrypted at rest already, but defense-in-depth) +
// raw payload fields that contain raw bank API responses.

const PII_FIELD_NAMES = new Set<string>([
  // Identity (Clerk + portfolio User table)
  "email",
  "emailAddress",
  "displayName",
  "firstName",
  "lastName",
  "fullName",
  "phone",
  "phoneNumber",
  "address",
  "addressLine1",
  "addressLine2",
  // Auth (any token / secret that could grant access)
  "password",
  "token",
  "apiKey",
  "secret",
  "accessToken",
  "refreshToken",
  "sessionToken",
  "clerkUserId", // pseudonymous but still subject identifier
  // Bank / financial — counterparty PII commonly lands here
  "accountNumber",
  "accountNumberLast4",
  "routingNumber",
  "bankName",
  // Bank statement payload — line description often contains
  // counterparty name + check memo ("CHECK 1234 PAID TO JANE DOE").
  // BankStatementLine.description is encrypted at rest (recon PR for
  // BankStatementLine encryption); belt-and-suspenders for monitoring.
  "description",
  "memo",
  "notes",
  // BankStatement.rawPayload — raw bank API response (encrypted at
  // rest). Could include full account numbers, party names, addresses.
  "rawPayload",
  "filename",
  // AI suggestion surfaces — AiSuggestion.candidatesJson contains
  // the model's reasoning + can include extracted entity values.
  // Encrypted at rest; defense-in-depth here.
  "candidatesJson",
]);

const REDACTED = "[REDACTED]";

/**
 * Deep-clone `value` with any property whose name is in PII_FIELD_NAMES
 * masked to "[REDACTED]". Arrays traversed; primitives pass through.
 *
 * Safe to call on any value — including unknown / never types from
 * caught errors. Returns the same shape as input.
 */
export function redactPii<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  // Special handling for Error objects — preserve the shape so the
  // caller can still see .name + .stack, but redact .message (which
  // often embeds user input).
  if (value instanceof Error) {
    return {
      name: value.name,
      message: REDACTED,
      stack: value.stack,
    };
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (PII_FIELD_NAMES.has(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redact(v);
    }
  }
  return out;
}

/**
 * The active allowlist — exported for unit tests + the SOC 2 audit
 * trail. Callers should never mutate this; the set is frozen-by-
 * convention (TypeScript doesn't enforce, but a code reviewer should).
 */
export const PII_FIELDS = PII_FIELD_NAMES;
