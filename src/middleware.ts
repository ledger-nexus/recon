// Companion-repo Next.js middleware — wires Clerk auth at the edge
// when CLERK_SECRET_KEY is set; otherwise a no-op pass-through.
//
// Mirrors ledger-core's middleware. Public routes (sign-in, sign-up,
// the repo's own /api/internal/* endpoints which are token-gated,
// /api/health, _next assets) are exempted from session auth.

import { NextResponse, type NextRequest } from "next/server";

const isClerkEnabled = () => {
  const k = process.env.CLERK_SECRET_KEY;
  return k != null && k.length > 0;
};

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
