// POST /api/internal/dsr/attribution
//
// Internal endpoint for ledger-core's buildUserDataExport() to fetch
// recon's DSR attribution slice (Privacy TSC). Wraps the already-
// shipped reconAttribution helper.
//
// Gated by INTERNAL_API_TOKEN (shared portfolio secret — same value
// ledger-core uses in its own env). Fails closed (503) if unset.
//
// NOTE on env-var naming: recon's existing /api/internal/bank-lines
// endpoint gates by RECON_INTERNAL_API_TOKEN (a recon-specific token
// integrations uses to call recon). This endpoint gates by
// INTERNAL_API_TOKEN — the shared portfolio secret ledger-core uses
// to call ALL companion repos for DSR attribution. They are separate
// values by design; conflating them would couple two unrelated
// trust boundaries.
//
// Wire format:
//   POST /api/internal/dsr/attribution
//   Authorization: Bearer $INTERNAL_API_TOKEN
//   Content-Type: application/json
//   { "userId": "<uuid>" }
//
// Success (200): ReconAttribution shape from recon-attribution.ts
//
// Failure:
//   503/401/400/500 envelope mirrors /api/internal/bank-lines

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { reconAttribution } from "@/lib/privacy/recon-attribution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

type ErrorCode = "UNAUTHORIZED" | "BAD_REQUEST" | "INTERNAL_ERROR";

function err(code: ErrorCode, message: string, status: number) {
  return NextResponse.json(
    { ok: false, error: { code, message } },
    { status }
  );
}

interface JsonBody {
  userId: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) {
    return err(
      "UNAUTHORIZED",
      "INTERNAL_API_TOKEN env var is not set — endpoint disabled. Set it in the deployment env to enable.",
      503
    );
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  if (!constantTimeEquals(authHeader, expected)) {
    return err("UNAUTHORIZED", "Invalid or missing bearer token", 401);
  }

  let body: JsonBody;
  try {
    body = (await req.json()) as JsonBody;
  } catch {
    return err("BAD_REQUEST", "Body must be valid JSON", 400);
  }

  if (
    !body.userId ||
    typeof body.userId !== "string" ||
    body.userId.length === 0
  ) {
    return err(
      "BAD_REQUEST",
      "Required: userId (non-empty string, typically a uuid)",
      400
    );
  }

  try {
    const attribution = await reconAttribution(prisma, body.userId);
    return NextResponse.json(attribution);
  } catch (e) {
    return err(
      "INTERNAL_ERROR",
      e instanceof Error ? e.message : "Unknown error assembling attribution",
      500
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "METHOD_NOT_ALLOWED",
        message:
          "POST only. Include `Authorization: Bearer $INTERNAL_API_TOKEN` and a JSON body of `{ userId }`.",
      },
    },
    { status: 405 }
  );
}
