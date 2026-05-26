// Companion-repo Clerk dispatch.
//
// The companion repos don't own a User table — that lives in
// ledger-core's shared Postgres. For Phase 8, this module gates
// page access via Clerk's middleware. A future enhancement could
// resolve the Clerk session to a TenantMembership in the shared DB,
// but that's out of Phase 8 scope.
//
// When CLERK_SECRET_KEY is unset, the entire Clerk path is skipped
// and the repo behaves as before (open access). This is the dev /
// staging fallback; production is expected to set the keys.

/** True when the Clerk env keys are configured for this process. */
export function isClerkEnabled(): boolean {
  const k = process.env.CLERK_SECRET_KEY;
  return k != null && k.length > 0;
}
