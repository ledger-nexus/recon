# Security policy

## Reporting a vulnerability

If you have found a security issue in this repository, please report it
**privately** via one of:

- Email: `security@ledger-nexus.com` (replace with real address when
  the domain is provisioned)
- GitHub: open a private security advisory at
  https://github.com/ledger-nexus/REPO/security/advisories/new

Please **do not** open a public GitHub issue for security problems.

## Response timeline

- **48 hours**: acknowledgement of receipt
- **7 days**: initial triage + severity assessment
- **30 days**: fix or remediation plan, whichever applies
- **90 days**: public disclosure following the standard responsible-
  disclosure window after the fix ships

## In-scope

- All code in this repository
- Production deployment at the published URL (when one exists)
- Internal HTTP boundary endpoints (`/api/internal/*`) — token-gated;
  bypass attempts welcome

## Out-of-scope

- Third-party services we depend on (Vercel, Neon, Anthropic, Plaid,
  GitHub) — report directly to those vendors
- Social engineering against employees
- Physical security of contributor workstations

## Recognition

We don't currently offer a bug bounty. We will acknowledge reporters
in the project changelog with permission, and provide a signed letter
of acknowledgement on request.

## SOC 2 framework

This project is being prepared for SOC 2 Type 1 audit readiness. See
`docs/SOC2_READINESS.md` for the current assessment and remediation
status.

