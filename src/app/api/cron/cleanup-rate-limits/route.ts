// GET /api/cron/cleanup-rate-limits
//
// Daily cleanup of two short-lived audit tables that grow unbounded:
//
//   - RateLimitEvent   — useful only inside the trailing 1-hour window.
//                        Default retention: 7 days (keeps recent audit
//                        without bloating the table).
//   - AiSpendAlert     — historical alert ledger. Default retention:
//                        90 days. Long enough to answer "was this
//                        customer warned before they hit the cap last
//                        quarter?"; short enough to keep the table tiny.
//
// Wired to Vercel Cron via vercel.json. Vercel automatically sets the
// `Authorization: Bearer $CRON_SECRET` header on cron invocations when
// CRON_SECRET is configured in the deployment env. Without that header,
// we 401 (production) or pass-through (dev) — same fail-closed posture
// the middleware uses.
//
// Idempotent + safe to invoke at any cadence. Two DELETE statements,
// done.
//
// Manual invocation (e.g. backfill cleanup from a long-running staging
// env): `curl -H "Authorization: Bearer $CRON_SECRET" https://.../api/cron/cleanup-rate-limits`

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Retention windows are env-overridable so a deploy with high AI volume
// can tighten them, or a staging env can keep more for inspection.
function days(env: string, fallback: number): number {
  const raw = process.env[env];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Auth: Vercel sends `Authorization: Bearer $CRON_SECRET` on cron
  // invocations when CRON_SECRET is set. Match the middleware's
  // fail-closed posture — refuse in production if the secret is unset.
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") ?? "";

  if (!secret) {
    if (isProd()) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "CRON_SECRET env var is not set — endpoint disabled in production. Set it in the deployment env to enable Vercel Cron invocations.",
        },
        { status: 503 }
      );
    }
    // Dev convenience: no secret required when not in production.
  } else {
    const expected = `Bearer ${secret}`;
    if (!constantTimeEquals(authHeader, expected)) {
      return NextResponse.json(
        { ok: false, error: "Invalid or missing bearer token" },
        { status: 401 }
      );
    }
  }

  const rateLimitDays = days("RATE_LIMIT_RETENTION_DAYS", 7);
  const spendAlertDays = days("AI_SPEND_ALERT_RETENTION_DAYS", 90);

  const rateLimitCutoff = new Date(Date.now() - rateLimitDays * 24 * 60 * 60 * 1000);
  const spendAlertCutoff = new Date(Date.now() - spendAlertDays * 24 * 60 * 60 * 1000);

  const [rateLimitDeleted, spendAlertDeleted] = await Promise.all([
    prisma.rateLimitEvent.deleteMany({
      where: { createdAt: { lt: rateLimitCutoff } },
    }),
    prisma.aiSpendAlert.deleteMany({
      where: { sentAt: { lt: spendAlertCutoff } },
    }),
  ]);

  const result = {
    ok: true,
    rateLimitEvent: {
      retentionDays: rateLimitDays,
      cutoff: rateLimitCutoff.toISOString(),
      deleted: rateLimitDeleted.count,
    },
    aiSpendAlert: {
      retentionDays: spendAlertDays,
      cutoff: spendAlertCutoff.toISOString(),
      deleted: spendAlertDeleted.count,
    },
  };

  // Log to stdout so Vercel's Function Logs surface the daily reap.
  console.log("[cron] cleanup-rate-limits", JSON.stringify(result));

  return NextResponse.json(result);
}
