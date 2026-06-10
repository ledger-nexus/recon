// Plan-based repo access gate.
//
// Each companion repo decides which plans include it. recon is the
// most-included (every plan) because bank reconciliation is the
// foundation feature; the other repos tighten progressively:
//
//   recon         — free, starter, growth, scale  (all plans)
//   revenue-rec   — growth, scale
//   fa-amort      — growth, scale
//   integrations  — scale
//
// Mirror of ledger-core's plans.ts availableRepos[]. When the
// canonical catalog changes, update the constant here too.
//
// Enforcement posture matches limits.ts in ledger-core:
//   - BILLING_ENFORCE_LIMITS=true  → hard refusal (throws / 403)
//   - BILLING_ENFORCE_LIMITS=false → soft mode: console.warn but allow
//
// Pages call getRepoAccess() and render an upgrade banner when not
// included. Server Actions that cost real money (AI calls) should
// call requireRepoAccess() to refuse hard.

import type { CurrentTenant } from "./session";

const THIS_REPO_NAME = "recon";

// Plans that include this repo. Mirror of plans.ts in ledger-core.
const PLANS_INCLUDING_THIS_REPO: ReadonlySet<string> = new Set([
  "free",
  "starter",
  "growth",
  "scale",
]);

export class RepoNotIncludedError extends Error {
  constructor(
    public readonly currentPlan: string,
    public readonly repoName: string
  ) {
    super(
      `The ${repoName} module is not included in your "${currentPlan}" plan. Upgrade at /admin/billing.`
    );
    this.name = "RepoNotIncludedError";
  }
}

export interface RepoAccessView {
  included: boolean;
  currentPlan: string;
  repoName: string;
}

function isEnforcementOn(): boolean {
  return process.env.BILLING_ENFORCE_LIMITS === "true";
}

/**
 * Resolve the effective plan key for the tenant. "active" / "trialing"
 * subscriptions use their billingPlan; everything else (null,
 * "canceled", "past_due", etc.) falls back to "free".
 */
function effectivePlan(tenant: CurrentTenant): string {
  const status = tenant.subscriptionStatus;
  if (status === "active" || status === "trialing") {
    return tenant.billingPlan ?? "free";
  }
  return "free";
}

/**
 * Returns the access view for the current tenant. Pages call this to
 * decide whether to render the normal content or an upgrade banner.
 */
export function getRepoAccess(tenant: CurrentTenant): RepoAccessView {
  const currentPlan = effectivePlan(tenant);
  return {
    included: PLANS_INCLUDING_THIS_REPO.has(currentPlan),
    currentPlan,
    repoName: THIS_REPO_NAME,
  };
}

/**
 * Throws RepoNotIncludedError when the tenant's plan doesn't include
 * this repo AND enforcement is on. In soft mode (default in dev),
 * logs a warning but doesn't throw — lets existing setups keep working
 * during the rollout window.
 */
export function requireRepoAccess(tenant: CurrentTenant): void {
  const access = getRepoAccess(tenant);
  if (access.included) return;
  if (!isEnforcementOn()) {
    console.warn(
      `[repo-access] tenant=${tenant.id} would-block ${THIS_REPO_NAME} ` +
        `access on ${access.currentPlan} plan; soft mode`
    );
    return;
  }
  throw new RepoNotIncludedError(access.currentPlan, THIS_REPO_NAME);
}
