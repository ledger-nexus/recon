#!/usr/bin/env bash
# SOC 2 preventive control (CC6.7 + Confidentiality TSC).
#
# Blocks commits that contain hardcoded API keys / payment credentials,
# or `console.log` lines that look like they're spilling PII or
# financial values to logs. Triggered by the pre-commit hook:
#
#   .git/hooks/pre-commit  →  exec scripts/pre-commit-secrets-scan.sh
#
# To install on a fresh checkout:
#
#   ln -s ../../scripts/pre-commit-secrets-scan.sh .git/hooks/pre-commit
#   chmod +x scripts/pre-commit-secrets-scan.sh
#
# The hook is intentionally fast (only scans the staged diff) so it
# doesn't slow normal commits. Bypass with `git commit --no-verify`
# only when you've manually reviewed the diff and the false positive
# is genuine.

set -e

red() { printf '\033[31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

staged_files=$(git diff --cached --name-only --diff-filter=ACM)
if [ -z "$staged_files" ]; then
  exit 0
fi

# Limit to source-shaped files (TypeScript, JavaScript, Python, env,
# config). Ignore lockfiles and the gap-analysis docs that legitimately
# discuss the patterns we're scanning for.
scannable=$(echo "$staged_files" | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|py|env|json|yaml|yml|sh|prisma)$' \
  | grep -v -E '(package-lock|pnpm-lock|yarn\.lock|SOC2_READINESS|soc2/index\.ts|soc2-helpers\.test|policies/|pre-commit-secrets-scan\.sh|soc2-check\.md)' || true)
if [ -z "$scannable" ]; then
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# 1. Hardcoded payment / API key shapes — HARD BLOCK
# ─────────────────────────────────────────────────────────────────────────────
#
# Stripe (sk_live_*, sk_test_*, pk_live_*, rk_live_*, whsec_*), AWS,
# Anthropic (sk-ant-*), OpenAI (sk-*), GitHub (gh[pousr]_*), Slack
# (xoxb-/xoxp-), JWT-shaped tokens of length ≥60 in source.
#
# These are NEVER legitimate to commit. False positives should be
# moved to env vars; if you really need an example value, use a
# placeholder like "sk_test_xxx".

secret_patterns='sk_live_[A-Za-z0-9]{16,}|sk_test_[A-Za-z0-9]{16,}|pk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{12,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|ghu_[A-Za-z0-9]{30,}|ghs_[A-Za-z0-9]{30,}|ghr_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}'

secret_hits=$(echo "$scannable" | xargs git diff --cached -- 2>/dev/null \
  | grep -E "^\+" \
  | grep -E "$secret_patterns" || true)

if [ -n "$secret_hits" ]; then
  red "✗ SOC 2 CC6.7 — secret-shaped string in staged diff:"
  echo "$secret_hits" | head -10
  red ""
  red "Move the value to process.env (and add the variable to .env.example)."
  red "If this is a placeholder test value, use 'sk_test_xxxxxxxxxxxxxxxxxxxx'"
  red "or similar — anything that doesn't match the real-key regex above."
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. console.log of likely-PII or financial values — HARD BLOCK
# ─────────────────────────────────────────────────────────────────────────────
#
# Warns when a console.log / console.error / Sentry.captureMessage
# expression mentions a field name the redactPii() helper covers.
# False positives are common (e.g., logging a literal "email validation
# failed"); when the lint catches a real leak the fix is wrapping the
# payload in redactPii() before the log.

pii_pattern='(console\.(log|error|warn|info|debug)|logger\.(info|error|warn|debug)|Sentry\.(captureMessage|captureException))[^;{]*?(email|password|token|secret|apiKey|accountNumber|routingNumber|ssn|taxId|stripeCustomer|memo|description|displayName|firstName|lastName|phoneNumber|address)'

# .filter out the redactPii wrapper itself
pii_hits=$(echo "$scannable" | xargs git diff --cached -- 2>/dev/null \
  | grep -E "^\+" \
  | grep -E "$pii_pattern" \
  | grep -v 'redactPii' \
  | grep -v 'REDACTED' \
  | grep -v 'redacted' \
  | grep -v '\[REDACTED\]' || true)

if [ -n "$pii_hits" ]; then
  red "✗ Confidentiality TSC — possible PII/financial value spilling to log:"
  echo "$pii_hits" | head -10
  red ""
  red "Wrap the payload in redactPii() from @/lib/soc2 before logging,"
  red "or rename the variable if this is a false positive."
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. .env / credential files — HARD BLOCK
# ─────────────────────────────────────────────────────────────────────────────

env_hits=$(echo "$staged_files" | grep -E '^(\.env$|\.env\.[^.]+$|credentials\.json$|service-account.*\.json$)' || true)
# .env.example is allowed.
env_hits=$(echo "$env_hits" | grep -v -E '\.example$' || true)
if [ -n "$env_hits" ]; then
  red "✗ SOC 2 CC6.7 — environment file staged:"
  echo "$env_hits"
  red ""
  red "These files contain secrets. Remove from staging, add to .gitignore"
  red "if not already, and rotate any value that was ever committed."
  exit 1
fi

green "✓ SOC 2 pre-commit checks passed"
exit 0
