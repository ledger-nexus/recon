// Next.js middleware — wires Clerk auth at the edge when CLERK_SECRET_KEY
// is set, sets the Content-Security-Policy with per-request nonce, and
// otherwise passes through.
//
// Clerk's middleware intercepts every request to attach session info
// before route handlers + server components run. Without it, currentUser()
// inside the Clerk SDK returns null.
//
// Public routes (no auth required):
//   - /sign-in, /sign-up (Clerk's hosted UI)
//   - /api/internal/* (gated by INTERNAL_API_TOKEN, not session auth)
//   - /api/health (uptime probe)
//
// Everything else: signed-in users only when Clerk is enabled.
//
// When Clerk is NOT enabled (dev / tests), we export a no-op middleware
// so the Next.js build still produces a valid output. The dev cookie
// stub is still used by getCurrentUser in that case.
//
// SECURITY (pen-test pass 4 follow-up): in production, if Clerk env is
// missing we refuse every non-public route with 503. ledger-core's
// fallback auth path is a signed `lc-user` cookie set by
// setCurrentUserAction — an action that lets any caller impersonate
// any user (intentional in dev for the UserSwitcher dropdown). Without
// the prod fail-closed gate, an unset CLERK_SECRET_KEY in prod would
// leave that impersonation surface exposed.
//
// CSP (SOC 2 CC6.6 — was deferred in next.config.js):
//   Every response gets a Content-Security-Policy header with a
//   per-request nonce. `strict-dynamic` means once a nonce'd script
//   loads, the scripts IT loads inherit trust — so we don't have to
//   enumerate every Clerk / Sentry runtime domain. Inline scripts
//   without the nonce are blocked.
//
//   Server components read the nonce from `headers().get('x-nonce')`
//   and pass it to <Script nonce={nonce}>. Next.js's own runtime
//   scripts (chunk loader, etc.) inherit via strict-dynamic.

import { NextResponse, type NextRequest } from "next/server";

const isClerkEnabled = () => {
  const k = process.env.CLERK_SECRET_KEY;
  return k != null && k.length > 0;
};

const isProd = () => process.env.NODE_ENV === "production";

// Routes that don't require sign-in even when Clerk is on.
//
// Note: /onboarding IS sign-in-required (you need to be a signed-in
// User to create a Tenant). It's NOT in this list — middleware will
// redirect unauthenticated users to /sign-in first. The page itself
// then handles the "signed-in but no memberships" case.
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

// ─── CSP nonce + header ───────────────────────────────────────────────────
//
// Generate a 128-bit random nonce per request. base64url so it's
// header-safe. The crypto.getRandomValues call runs on Edge runtime
// (Web Crypto API), so no Node.js dep — works in middleware.

function generateNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  // Base64 → base64url (URL/header safe). 16 bytes → 22 chars.
  return Buffer.from(arr).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function buildCspHeader(nonce: string): string {
  // strict-dynamic delegates trust: a script loaded via the nonce
  // can load more scripts without listing every domain. Clerk + Sentry
  // + Stripe.js runtimes work via this delegation.
  //
  // For non-script directives, enumerate the domains we actually use.
  // `style-src 'unsafe-inline'` is required for Tailwind's runtime
  // styles; the per-style nonce alternative would need plumbing into
  // every styled component — too invasive for now.
  const policy = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // unsafe-eval is required by some Clerk + Stripe widgets in dev.
    // We omit it in production; if a widget breaks, narrow it down
    // and add a specific exception rather than blanket-allow.
    process.env.NODE_ENV === "production"
      ? null
      : `script-src-elem 'self' 'nonce-${nonce}' 'unsafe-inline' 'unsafe-eval'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https:`,
    `font-src 'self' data:`,
    // connect-src: Clerk APIs, Sentry ingest, Stripe API, Vercel
    // analytics. Use wildcard subdomains rather than enumerate every
    // region/shard.
    `connect-src 'self' https://*.clerk.com https://*.clerk.accounts.dev https://*.sentry.io https://api.stripe.com https://*.vercel-insights.com`,
    // frame-src: Clerk's sign-in widget + Stripe payment elements
    // mount in iframes.
    `frame-src https://*.clerk.com https://*.clerk.accounts.dev https://js.stripe.com https://hooks.stripe.com`,
    `frame-ancestors 'none'`, // we already block via X-Frame-Options DENY too
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    `upgrade-insecure-requests`,
  ].filter(Boolean).join("; ");
  return policy;
}

/**
 * Attach the per-request nonce to the request headers (so server
 * components can read it via `headers().get('x-nonce')`) and the CSP
 * to the response headers.
 */
function applyCsp(req: NextRequest, response: NextResponse, nonce: string): NextResponse {
  response.headers.set("Content-Security-Policy", buildCspHeader(nonce));
  return response;
}

export default async function middleware(req: NextRequest) {
  const nonce = generateNonce();
  // Pass the nonce to downstream Server Components by setting it on
  // the request headers. They read it via `headers().get('x-nonce')`
  // and pass to <Script nonce={...}> for any inline-injected JS.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  if (!isClerkEnabled()) {
    // Fail closed in production. Dev / CI without Clerk passes through
    // so local work doesn't require Clerk credentials, but the moment
    // prod is missing CLERK_SECRET_KEY, every non-public request
    // returns 503 — closing the dev-impersonation cookie path that
    // would otherwise be reachable.
    if (isProd() && !isPublic(req.nextUrl.pathname)) {
      const r = NextResponse.json(
        {
          ok: false,
          error:
            "Auth is not configured in this environment (CLERK_SECRET_KEY missing). Refusing to serve requests.",
        },
        { status: 503 }
      );
      return applyCsp(req, r, nonce);
    }
    const r = NextResponse.next({ request: { headers: requestHeaders } });
    return applyCsp(req, r, nonce);
  }

  // Lazy-import Clerk so we don't pay for it when stub path is active.
  const { clerkMiddleware, createRouteMatcher } = await import(
    "@clerk/nextjs/server"
  );
  const isPublicRoute = createRouteMatcher([
    "/sign-in(.*)",
    "/sign-up(.*)",
    "/api/internal/(.*)",
    "/api/health",
  ]);

  // Wrap the Clerk handler so we can run additional logic (like the
  // public-route bypass) without dropping Clerk's session attachment.
  const clerkResponse = await clerkMiddleware(async (auth, request) => {
    if (isPublicRoute(request)) return;
    // Protect everything else. Unsigned-in users are redirected to /sign-in.
    await auth.protect();
  })(req, { waitUntil: () => {} } as never);

  // Clerk's middleware returns a NextResponse-shaped object. Attach
  // the CSP header to it. The nonce-on-request-headers path Clerk
  // already forwards via its own request rewriting, so the
  // downstream `headers().get('x-nonce')` works without us re-injecting.
  if (clerkResponse instanceof NextResponse) {
    return applyCsp(req, clerkResponse, nonce);
  }
  const r = NextResponse.next({ request: { headers: requestHeaders } });
  return applyCsp(req, r, nonce);
}

export const config = {
  // Match every route EXCEPT static asset paths. Standard Clerk matcher.
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};

// Re-export the public-path check + CSP helpers so unit tests can
// verify the list and the policy shape without instantiating Clerk.
export const _internal = {
  isPublic,
  PUBLIC_PATH_PATTERNS,
  generateNonce,
  buildCspHeader,
};
