// Error monitoring shim — SOC 2 CC7.2 (system monitoring) + CC7.3
// (security event evaluation).
//
// Mirror of ledger-core's `src/lib/monitoring/index.ts` (PR #10) and
// fa-amort's port (PR #21). Closes the recon half of portfolio-wide
// deficiency #5 (No Sentry / no error tracking; Medium severity).
//
// Why this exists:
//   SOC 2 expects "ongoing evaluations to ascertain whether components
//   of internal control are present and functioning." In practice
//   that's an error monitor (Sentry / Datadog / Axiom) that captures
//   exceptions, alerts on rate spikes, and retains evidence for the
//   auditor's observation window.
//
// Why a shim rather than a direct Sentry import:
//   1. We don't want to pay Sentry's bundle cost when the DSN is
//      absent (local dev, CI for tests, environments not yet
//      provisioned).
//   2. PII redaction must happen BEFORE the error reaches the monitor.
//      A direct Sentry.captureException(err) ships raw err.message +
//      stack — which on recon regularly embeds bank-line descriptions
//      (counterparty PII), account numbers, and AI extraction values.
//      Going through this shim runs `redactPii()` first.
//   3. When the team picks a monitoring vendor (Sentry vs Axiom vs
//      Datadog), only this file changes. Call sites stay stable.
//
// Configuration:
//   - `SENTRY_DSN` env var enables the real Sentry transport.
//   - Absent DSN → fallback to console.error wrapped in redactPii.
//     Still preserves the "we noticed this happened" trail.
//
// Call sites should look like:
//
//   import { captureError } from "@/lib/monitoring";
//
//   try {
//     await prisma.bankStatement.create({ ... });
//   } catch (e) {
//     captureError(e, {
//       context: "recon/upload-statement",
//       extra: { statementId, userId },
//     });
//     // Decide separately whether to swallow or re-throw — the shim
//     // does not control flow.
//   }

import { redactPii, sanitizeErrorForCapture } from "@/lib/soc2/redact-pii";

/**
 * Context passed alongside an error for triage. NEVER include raw user
 * objects, emails, names, or financial values — the shim redacts
 * field-name-matched keys but a free-text `message: "Statement from
 * Acme Bank"` slips through. Keep context structured.
 */
export interface ErrorContext {
  /** Coarse-grained category for triage ("server-action", "ledger-bridge", "ai"). */
  context?: string;
  /** Specific action / route name for grouping. */
  actionName?: string;
  /** Tenant id, if applicable — helps an auditor scope an investigation. */
  tenantId?: string;
  /** Actor user id (not email — emails are PII). */
  actorUserId?: string;
  /** Anything else, redacted before transmission. */
  extra?: Record<string, unknown>;
}

let sentryReady = false;
type SentryShape = {
  captureException(err: unknown, opts?: { extra?: Record<string, unknown> }): void;
  captureMessage(
    msg: string,
    opts?: { extra?: Record<string, unknown>; level?: string }
  ): void;
  init?(opts: {
    dsn: string;
    environment?: string;
    tracesSampleRate?: number;
  }): void;
};
let sentryClient: SentryShape | null = null;

/**
 * Lazy-init the Sentry SDK only if SENTRY_DSN is set. Idempotent — safe
 * to call from every captureError() entry. Returns the client or null
 * if Sentry is disabled / fails to load.
 *
 * The dynamic require() keeps Sentry out of the bundle for builds that
 * don't ship to a configured environment.
 */
function getSentryClient(): SentryShape | null {
  if (sentryReady) return sentryClient;
  sentryReady = true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require("@sentry/nextjs") as SentryShape;
    if (Sentry.init) {
      Sentry.init({
        dsn,
        environment: process.env.NODE_ENV ?? "production",
        // Conservative default — every error captured, no perf sampling.
        // Tune via SENTRY_TRACES_SAMPLE_RATE env when the team wants APM.
        tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0"),
      });
    }
    sentryClient = Sentry;
    return Sentry;
  } catch (e) {
    // Package not installed — that's expected in dev. The fallback
    // below still preserves the observation trail.
    console.error("[monitoring] @sentry/nextjs not available", e);
    return null;
  }
}

/**
 * Capture an exception. PII redacted before transmission. Always safe
 * to call — falls back to console when Sentry is unavailable.
 *
 * Returns void; the caller decides whether to swallow or re-throw.
 */
export function captureError(err: unknown, context: ErrorContext = {}): void {
  const safeContext = redactPii({
    context: context.context,
    actionName: context.actionName,
    tenantId: context.tenantId,
    actorUserId: context.actorUserId,
    ...(context.extra ? { extra: context.extra } : {}),
  });

  const Sentry = getSentryClient();
  if (Sentry) {
    // 14th-pass H1 fix: sanitize the err so Sentry receives a copy
    // with .message redacted + .stack preamble stripped. Without this,
    // Sentry serializes err.stack server-side including the original
    // message ("Error: alice@x.com\n    at ...") — a Confidentiality
    // TSC leak.
    Sentry.captureException(sanitizeErrorForCapture(err), {
      extra: safeContext,
    });
    return;
  }

  // Fallback: console.error. The trail is less useful for SOC 2 than
  // a real monitor (Vercel function logs roll over in ~7 days on the
  // free tier) but at least the event isn't silent.
  //
  // We deliberately do NOT pass `err` directly — Prisma errors echo
  // column values in `.message` and `console.error` would print them.
  // Instead extract err.name + err.code and let redactPii handle the
  // rest.
  //
  // 14th-pass M1 fix: cap err.code length to 16 chars. Some adapter
  // wrappers (Neon serverless driver) embed host:port in .code on
  // connection errors. The cap defangs operational PII without
  // killing Prisma's short error codes ("P2002", "P2025") which fit.
  const summary =
    err instanceof Error
      ? {
          errName: err.name,
          errCode: ((err as { code?: unknown }).code as string | undefined)
            ?.slice(0, 16),
        }
      : { errPrimitive: String(err) };
  console.error("[monitoring]", { ...safeContext, ...summary });
}

/**
 * Capture a non-error event (e.g., "AI matching skipped — no
 * candidates"). Use for security-relevant observations that aren't
 * exceptions — helps an auditor see the trail of "we noticed X".
 */
export function captureMessage(
  message: string,
  level: "info" | "warning" | "error" = "info",
  context: ErrorContext = {}
): void {
  const safeContext = redactPii({
    context: context.context,
    actionName: context.actionName,
    tenantId: context.tenantId,
    actorUserId: context.actorUserId,
    ...(context.extra ? { extra: context.extra } : {}),
  });

  const Sentry = getSentryClient();
  if (Sentry) {
    Sentry.captureMessage(message, { extra: safeContext, level });
    return;
  }
  const fn =
    level === "error"
      ? console.error
      : level === "warning"
        ? console.warn
        : console.log;
  fn("[monitoring]", message, safeContext);
}

/**
 * Boot-time init helper. Call from instrumentation.ts (Next.js 14+
 * convention) so Sentry initializes on server startup before the
 * first request. Returns true if Sentry took effect.
 */
export function initMonitoring(): boolean {
  const client = getSentryClient();
  return !!client;
}
