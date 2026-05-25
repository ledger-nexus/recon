# Branch protection — what to set in GitHub repo settings

SOC 2 CC8 expectation: changes to production code are reviewed and
tested before merge. GitHub enforces this via "branch protection rules"
on the `main` branch.

This file documents what those settings should be. The settings live
in GitHub repo settings UI, not in code — auditors will ask to see
both: the policy (this file) AND the configured setting.

## Required on `main`

Settings → Branches → Add branch protection rule for `main`:

- [ ] **Require a pull request before merging**
  - [ ] Require approvals: **1** (or 0 if solo, with the compensating
        control documented in `docs/policies/change-management.md`)
  - [ ] Dismiss stale pull request approvals when new commits are pushed
  - [ ] Require review from Code Owners (uses `.github/CODEOWNERS`)

- [ ] **Require status checks to pass before merging**
  - [ ] Require branches to be up to date before merging
  - Required checks (add these as they exist):
    - [ ] `test` (from `.github/workflows/ci.yml`)
    - [ ] `gitleaks` (from `.github/workflows/security.yml`)
    - [ ] `npm-audit` (from `.github/workflows/security.yml`)
    - [ ] `codeql` (from `.github/workflows/security.yml`)

- [ ] **Require conversation resolution before merging**
- [ ] **Require signed commits** (raises the bar on commit-author
      attribution for SOC 2 CC8 evidence)
- [ ] **Require linear history**
- [ ] **Do not allow bypassing the above settings**

## Apply via gh CLI

```bash
gh api repos/ledger-nexus/REPO/branches/main/protection \
  --method PUT \
  --input - <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["test", "gitleaks", "npm-audit", "codeql"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1
  },
  "required_signatures": true,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "restrictions": null
}
EOF
```

## Solo-dev exception

Until a second engineer joins, the "1 approving review" requirement
makes development impossible (you can't approve your own PR). Two
options:

1. **Require 0 reviews but require Code Owners.** GitHub will block
   self-merge if you're the only Code Owner and you wrote the PR.
   Effectively forces use of an "automated reviewer" check
   (Claude / Cursor / etc.) to comment first.

2. **Set `enforce_admins=false`** so the solo owner can bypass when
   needed, but the bypass is logged. Document each bypass in
   `docs/policies/change-management.md`.

Option 2 is the honest answer for v1. Document the bypass exception
formally — auditors will accept "solo founder, fully transparent
bypass log" but will NOT accept "settings configured but disabled".

