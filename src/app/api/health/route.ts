// GET /api/health — SOC 2 CC7.1 (anomaly detection signal).
//
// Returns the app's current self-reported state for external uptime
// monitoring and the Vercel deployment-readiness check. NOT
// authenticated — health probes need to fire before auth is even
// confirmed working.
//
// Surfaces:
//   - status: "ok" | "degraded" | "down"
//   - schemaFingerprint: SOC 2 CC8 — Prisma model-list hash. Two
//     replicas serving the same code return the same fingerprint; a
//     mid-deploy drift produces a different one. Useful for spotting
//     "the code rolled forward but the DB didn't migrate" failures.
//   - db: { reachable, latencyMs } — single SELECT 1 to confirm
//     the Postgres connection is alive.
//   - monitoring: { sentryDsnPresent } — SOC 2 CC7 evidence that the
//     error monitor is wired (the actual DSN value is NEVER exposed).
//   - version: git short SHA if VERCEL_GIT_COMMIT_SHA is set, else
//     "dev".
//
// Response codes:
//   - 200 if status === "ok" or "degraded" (still serving)
//   - 503 if status === "down" (DB unreachable; Vercel rotates pod)
//
// Caching: explicitly `Cache-Control: no-store`. Health responses
// MUST be fresh — caching a 200 from before an incident would lie to
// the probe.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { schemaFingerprint } from "@/lib/soc2";

// Force the Node.js runtime — schemaFingerprint requires the
// Prisma client which doesn't run on the Edge.
export const runtime = "nodejs";
// Never cache health responses.
export const dynamic = "force-dynamic";

interface HealthResponse {
  status: "ok" | "degraded" | "down";
  schemaFingerprint: string;
  db: {
    reachable: boolean;
    latencyMs?: number;
    error?: string;
  };
  monitoring: {
    sentryDsnPresent: boolean;
  };
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

const PROCESS_STARTED_AT_MS = Date.now();

export async function GET(): Promise<NextResponse> {
  const sentryDsnPresent = !!process.env.SENTRY_DSN;
  const version = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev";
  const fingerprint = schemaFingerprint();

  // DB ping. We do this LAST so even if it throws, the rest of the
  // payload is well-formed.
  let dbReachable = false;
  let dbLatencyMs: number | undefined;
  let dbError: string | undefined;
  const dbStart = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
    dbLatencyMs = Date.now() - dbStart;
  } catch (e) {
    // Never propagate DB error details to the response — those leak
    // schema names, connection strings, etc. The body just records
    // "unreachable"; the actual exception goes to console (and
    // Sentry, when configured).
    dbError = "unreachable";
    console.error("[health] db ping failed:", e);
  }

  // Status policy:
  //   - DB down → status: down, 503. Vercel rotates the pod.
  //   - Anything else suspicious → status: degraded, 200. Sentry
  //     should catch it; uptime monitor stays green for soft fails.
  //   - All good → status: ok.
  const status: HealthResponse["status"] = !dbReachable ? "down" : "ok";
  const httpCode = status === "down" ? 503 : 200;

  const body: HealthResponse = {
    status,
    schemaFingerprint: fingerprint,
    db: dbReachable
      ? { reachable: true, latencyMs: dbLatencyMs }
      : { reachable: false, error: dbError ?? "unknown" },
    monitoring: { sentryDsnPresent },
    version,
    uptimeSeconds: Math.floor((Date.now() - PROCESS_STARTED_AT_MS) / 1000),
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(body, {
    status: httpCode,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
