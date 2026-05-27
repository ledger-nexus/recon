// Tenant-aware session helpers for recon's Server Actions.
//
// SECURITY (pen-test pass 4): every Server Action that takes an id
// from the client AND does a DB read/write MUST call requireCurrentUser
// + requireCurrentTenant, then tenant-scope the lookup. Without this
// pair, a signed-in user from tenant A could pass a UUID from tenant
// B and write to B's records (statements, matches, ignored lines,
// adjustment JEs). The middleware-level Clerk gate verifies SESSION
// presence but not record ownership.
//
// The flow:
//   1. Clerk middleware authenticated the session at the edge.
//   2. clerkServer.auth() gives us the Clerk userId in this RSC/Action.
//   3. We map Clerk userId → ledger-core's app_user.id by matching the
//      Clerk session's primary email against User.email. The mapping
//      lives in the shared DB; recon's Prisma client has just enough
//      schema to query it (declared in prisma/schema.prisma).
//   4. The user's TenantMembership row gives us the active tenant.
//      Recon doesn't (yet) support multi-tenant users — if the user
//      belongs to >1 tenant, we'd need a tenant-switcher cookie like
//      ledger-core has. For now, single membership = current tenant;
//      multi-membership returns null (caller fails closed).
//
// When CLERK_SECRET_KEY is unset (local dev with auth disabled),
// every helper here throws NotAuthenticatedError. This is deliberate:
// recon's Server Actions previously ran with no auth at all, which
// was the gap; turning the gate ON in dev too forces every developer
// to set up Clerk before they can touch the write surface.

import { prisma } from "@/lib/db";

export interface CurrentUser {
  /** The user's id in the shared app_user table. */
  id: string;
  email: string;
  displayName: string;
}

export interface CurrentTenant {
  id: string;
  slug: string;
  name: string;
  role: string;
}

export class NotAuthenticatedError extends Error {
  constructor() {
    super("Not authenticated — sign in first");
    this.name = "NotAuthenticatedError";
  }
}

export class NoTenantSelectedError extends Error {
  constructor() {
    super(
      "No active tenant — you're not a member of any tenant, or you're a member of multiple and need to pick one"
    );
    this.name = "NoTenantSelectedError";
  }
}

/**
 * Resolve the Clerk session to a recon-side CurrentUser. Returns null
 * when Clerk is disabled or the session has no user.
 *
 * The Clerk userId itself isn't stored in app_user; we match by the
 * session's primary email. If no app_user matches, the Clerk user has
 * no presence in the shared DB and we treat them as unauthenticated.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const clerkEmail = await resolveClerkEmail();
  if (!clerkEmail) return null;
  const user = await prisma.user.findUnique({
    where: { email: clerkEmail },
    select: { id: true, email: true, displayName: true, isActive: true },
  });
  if (!user || !user.isActive) return null;
  return { id: user.id, email: user.email, displayName: user.displayName };
}

export async function requireCurrentUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) throw new NotAuthenticatedError();
  return u;
}

/**
 * Single-active-tenant resolution. Returns the user's tenant when
 * they have exactly one membership; null otherwise. recon doesn't
 * yet have a per-request tenant cookie, so multi-tenant users hit
 * the "pick one" error.
 */
export async function getCurrentTenant(): Promise<CurrentTenant | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const memberships = await prisma.tenantMembership.findMany({
    where: { userId: user.id },
    include: { tenant: { select: { id: true, slug: true, name: true } } },
  });
  if (memberships.length !== 1) return null;
  const m = memberships[0];
  return {
    id: m.tenant.id,
    slug: m.tenant.slug,
    name: m.tenant.name,
    role: m.role,
  };
}

export async function requireCurrentTenant(): Promise<CurrentTenant> {
  await requireCurrentUser();
  const t = await getCurrentTenant();
  if (!t) throw new NoTenantSelectedError();
  return t;
}

/**
 * Read the current Clerk session's primary email. Returns null when
 * Clerk is disabled or the session has no signed-in user.
 *
 * Wrapped in an async import so that `@clerk/nextjs/server` isn't a
 * required dependency at module-eval time in environments where Clerk
 * is intentionally disabled (CI, some tests).
 */
async function resolveClerkEmail(): Promise<string | null> {
  if (!process.env.CLERK_SECRET_KEY) return null;
  try {
    const { auth, clerkClient } = await import("@clerk/nextjs/server");
    const { userId } = await auth();
    if (!userId) return null;
    const client = await clerkClient();
    const clerkUser = await client.users.getUser(userId);
    return clerkUser.primaryEmailAddress?.emailAddress ?? null;
  } catch {
    return null;
  }
}
