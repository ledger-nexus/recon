Audit the pending changes (current `git diff` against origin/main, or
staged diff if nothing is committed yet) against the SOC 2 controls
documented in CLAUDE.md and `src/lib/soc2/index.ts`.

For each control below, state PASS, FAIL, or N/A with one-line
reasoning. For any FAIL, identify the specific file and line, explain
the violation, and propose the fix. Cite the Common Criterion in the
finding.

## Controls to check

### CC6.1 — Multi-tenant isolation (IDOR defense)
- New or modified Prisma queries: any `findUnique({ where: { id } })`
  on a customer-data table without a tenantId constraint is a FAIL.
  Should be `findFirst({ where: { id, tenantId } })` followed by
  `assertTenantScope()` from `@/lib/soc2`.
- Any relation filter `entity: { code: x }` without a tenantId join
  is a potential FAIL — flag if entity codes can collide across
  tenants.
- New tables that hold customer data: must have `tenantId UUID` +
  `@@index([tenantId])`.

### CC5/CC6/CC7 — Audit logging
- New Server Actions that mutate data: must call
  `auditPrivilegedAction` or use `auditedMutation()` from
  `@/lib/soc2`. Missing → FAIL.
- Any UPDATE or DELETE on `audit_log` rows → FAIL (table is
  append-only).

### CC6.3 — Authorization
- New Server Actions / API routes: must call `requirePermission(...)`
  from `@/lib/auth/policy` after authentication. "Signed in" alone
  is not enough → FAIL.
- Hardcoded role checks (`if (user.role === "ADMIN")`) instead of
  named permissions → FAIL.

### CC6.7 — Secrets handling
- Hardcoded API keys (look for `sk_live_*`, `sk_test_*`, JWT-shaped
  strings, base64 strings > 32 chars in source) → FAIL.
- `===` comparison on tokens or HMACs → FAIL (use
  `constantTimeEqual` from `@/lib/soc2`).
- Webhook handlers that don't verify signatures → FAIL.

### CC6.8 — Input validation
- New API route / Server Action without Zod parsing of the input →
  FAIL.
- Client-provided ids used without re-checking ownership server-side
  → FAIL.

### Confidentiality TSC — Log hygiene
- Any new `console.log` / `console.error` / Sentry call that passes
  a user object, email, party, JE, or sub-ledger row directly →
  FAIL. Should run through `redactPii()` from `@/lib/soc2` first.

### CC7 — Error response sanitization
- Any `return Response.json(err)` / `throw new Error(detailed)` →
  FAIL. Errors crossing the network boundary must go through
  `sanitizeError()` from `@/lib/soc2`.

### CC8.1 — Change management
- New migration that's irreversible (no clean rollback path) →
  flag, not necessarily FAIL.
- Schema changes not documented in commit message → flag.

## Output format

```
SOC 2 audit — <branch-name> @ <short-sha>

CC6.1 (tenant isolation):  PASS|FAIL|N/A
  <one-line reason; if FAIL, file:line + fix>
CC5/6/7 (audit log):       PASS|FAIL|N/A
  ...
CC6.3 (authz):             PASS|FAIL|N/A
  ...
CC6.7 (secrets):           PASS|FAIL|N/A
  ...
CC6.8 (input validation):  PASS|FAIL|N/A
  ...
Confidentiality (logs):    PASS|FAIL|N/A
  ...
CC7 (error responses):     PASS|FAIL|N/A
  ...
CC8.1 (change mgmt):       PASS|FAIL|N/A
  ...

Summary: COMPLIANT | NON-COMPLIANT
  Critical: <count>  High: <count>  Medium: <count>  Low: <count>
```

Read `src/lib/soc2/index.ts` and CLAUDE.md's "SOC 2" section before
running the audit. End with a single-line `COMPLIANT` or
`NON-COMPLIANT` verdict.
