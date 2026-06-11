# Security policy

## Reporting a vulnerability

If you have found a security issue in this repository, please report it
**privately** via one of:

- Email: `security@ledger-nexus.com` (replace with real address when
  the domain is provisioned)
- GitHub: open a private security advisory at
  https://github.com/ledger-nexus/recon/security/advisories/new

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

This project is part of the `ledger-nexus` portfolio approaching SOC 2
Type 1 audit readiness. The authoritative framework lives in
`ledger-core/docs/`:

- `ledger-core/docs/SOC2_READINESS.md` — current assessment
- `ledger-core/docs/SOC2_CONTROL_MATRIX.md` — CC1–CC9 + 4 TSCs evidence map
- `ledger-core/docs/policies/` — 10-document policy framework
- `ledger-core/docs/architecture/portfolio-data-locations.md` —
  portfolio-wide data location map

This repo's specific scope:

- `docs/policies/data-subject-requests.md` — DSR procedure scoped to
  the bank statements + reconciliation data this repo holds
- `src/lib/privacy/recon-attribution.ts` — typed stub for the cross-
  repo attribution helper (counts only, never contents)

## Incident handling

Reports meeting the SEV-1/SEV-2 bar (bank-statement exfiltration,
unauthorized recon match, vendor breach affecting bank-feed source)
follow the portfolio procedure in
`ledger-core/docs/policies/incident-response.md`.

