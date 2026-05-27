// Companion-repo Next.js middleware — wires Clerk auth at the edge
// when CLERK_SECRET_KEY is set; otherwise a no-op pass-through in
// development only.
//
// SECURITY (pen-test pass 4 follow-up): in production, if Clerk env
// is missing we refuse every request with 503 — fail closed. Without
// this, an accidentally-unset env var in prod silently disables auth
// across the whole app and every Server Action's `requireCurrentUser`
// reverts to a no-op (it would call resolveClerkEmail → returns null
// → throws). The action paths fail safely, but page-level reads + any
// future un-gated code path do not. Closing the middleware at the
// edge in prod when Clerk isn't configured is the safest posture.

import { NextResponse, type NextRequest } from "next/server";

const isClerkEnabled = () => {
  const k = process.env.CLERK_SECRET_KEY;
  return k != null && k.length > 0;
};

const isProd = () => process.env.NODE_ENV === "production";

const PUBLIC_PATH_PATTERNS: RegExp[] = [
  /^\/sign-in(\/.*)?$/,
  /^\/sign-up(\/.*)?$/,
  /^\/api\/internal\//,
  /^\/api\/health$/,
  /^\/_next\//,
  /^\/favicon\.ico$/,
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATH_PATTERNS.some((re) => re.test(pathname));
}

export default async function middleware(req: NextRequest) {
  if (!isClerkEnabled()) {
    // Fail closed in production. Dev / CI proceeds without auth so
    // local work doesn't require Clerk credentials, but the moment
    // this code ships to a real environment without CLERK_SECRET_KEY,
    // every non-public request returns 503 with a clear error.
    if (isProd()) {
      const pathname = req.nextUrl.pathname;
      if (!isPublic(pathname)) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Auth is not configured in this environment (CLERK_SECRET_KEY missing). Refusing to serve requests.",
          },
          { status: 503 }
        );
      }
    }
    return NextResponse.next();
  }

  const { clerkMiddleware, createRouteMatcher } = await import(
    "@clerk/nextjs/server"
  );
  const isPublicRoute = createRouteMatcher([
    "/sign-in(.*)",
    "/sign-up(.*)",
    "/api/internal/(.*)",
    "/api/health",
  ]);

  return clerkMiddleware(async (auth, request) => {
    if (isPublicRoute(request)) return;
    await auth.protect();
  })(req, { waitUntil: () => {} } as never);
}

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};

export const _internal = { isPublic, PUBLIC_PATH_PATTERNS };
