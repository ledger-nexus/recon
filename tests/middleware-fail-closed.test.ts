// Pen-test pass 4 follow-up: verify the middleware fails closed in
// production when CLERK_SECRET_KEY is unset.
//
// Behavior matrix:
//   NODE_ENV=production + Clerk unset + non-public route → 503
//   NODE_ENV=production + Clerk unset + public route    → pass-through (200)
//   NODE_ENV!=production + Clerk unset                  → pass-through (dev convenience)
//
// We don't test the Clerk-enabled path here — that goes through the
// real Clerk middleware and needs Clerk env keys + an integration setup.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import middleware, { _internal } from "../src/middleware";

const origClerk = process.env.CLERK_SECRET_KEY;
const origNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  delete process.env.CLERK_SECRET_KEY;
  // vitest doesn't let us write to NODE_ENV directly; use Object.assign
  Object.assign(process.env, { NODE_ENV: "development" });
});
afterEach(() => {
  if (origClerk != null) process.env.CLERK_SECRET_KEY = origClerk;
  else delete process.env.CLERK_SECRET_KEY;
  if (origNodeEnv != null) Object.assign(process.env, { NODE_ENV: origNodeEnv });
});

function reqFor(pathname: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`);
}

/**
 * Middleware's return type is `Response | undefined` (Clerk's wrapper
 * can return undefined for public routes that don't need a response).
 * For the fail-closed paths exercised in this suite we DO expect a
 * concrete response — this helper asserts that and narrows the type
 * for the rest of the test. A real undefined leak surfaces here as
 * a clear test failure rather than a tsc workaround.
 */
async function expectResponse(
  p: ReturnType<typeof middleware>
): Promise<Response> {
  const r = await p;
  expect(r).toBeDefined();
  return r as Response;
}

describe("middleware fail-closed in production", () => {
  it("development without Clerk: lets non-public routes through (dev convenience)", async () => {
    Object.assign(process.env, { NODE_ENV: "development" });
    const res = await expectResponse(middleware(reqFor("/statements")));
    // NextResponse.next() returns 200 with no body — the route then handles.
    expect(res.status).toBe(200);
  });

  it("production without Clerk: REFUSES non-public routes with 503", async () => {
    Object.assign(process.env, { NODE_ENV: "production" });
    const res = await expectResponse(middleware(reqFor("/statements")));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/CLERK_SECRET_KEY/);
  });

  it("production without Clerk: STILL serves public routes (sign-in, health)", async () => {
    Object.assign(process.env, { NODE_ENV: "production" });
    const signIn = await expectResponse(middleware(reqFor("/sign-in")));
    expect(signIn.status).toBe(200);
    const health = await expectResponse(middleware(reqFor("/api/health")));
    expect(health.status).toBe(200);
    const next = await expectResponse(
      middleware(reqFor("/_next/static/foo.js"))
    );
    expect(next.status).toBe(200);
  });

  it("isPublic matcher covers expected paths", () => {
    expect(_internal.isPublic("/sign-in")).toBe(true);
    expect(_internal.isPublic("/sign-in/foo")).toBe(true);
    expect(_internal.isPublic("/sign-up")).toBe(true);
    expect(_internal.isPublic("/api/internal/bank-lines")).toBe(true);
    expect(_internal.isPublic("/api/health")).toBe(true);
    expect(_internal.isPublic("/favicon.ico")).toBe(true);
    expect(_internal.isPublic("/statements")).toBe(false);
    expect(_internal.isPublic("/admin/audit-log")).toBe(false);
  });
});
