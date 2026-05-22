# The ledger-core bridge

How recon writes journal entries without coupling its source code or generated Prisma client to ledger-core.

## The boundary

```
   recon process (port 3001)            ledger-core process (port 3000)
   ─────────────────────────             ─────────────────────────────
                                                  │
   postAdjustmentAction                   POST /api/internal/         
        │                                 │     journal-entries       
        ▼                                 ▼                           
   postEntryViaLedgerCore  ───HTTP───► route.ts                       
   (src/lib/ledger-bridge.ts)              │                           
                                          ▼                           
                                    postJournalEntry()                 
                                    (THE ledger entry point)           
```

There is exactly one HTTP call per adjustment JE. Inside ledger-core, the route handler does input validation, calls `postJournalEntry`, and serializes back the `{id, entryNumber, bookCode}` result (or a structured error).

## Why HTTP and not a source-level import

We considered three options:

| Option | Pros | Cons |
|---|---|---|
| **Source import via path alias** (`import { postJournalEntry } from "ledger-core/..."`) | No network hop, one process | Each repo generates its own Prisma client with branded types — the cast at the boundary is unsafe. Recon's schema mirror would need to expand to include `Item`, `Period`, `FiscalCalendar`, `PeriodClose` (the tables `postJournalEntry` queries), risking `prisma db push` mutating tables ledger-core owns. |
| **HTTP bridge** (chosen) | Each repo's types stay clean. Wire-format contract is audited. Recon and ledger-core can deploy independently. Mocked by injecting `fetch`. | Network hop in dev. Requires both services running. Shared-secret token plumbing. |
| **Workspace package** (extract `postJournalEntry` to a shared lib) | Strong type safety end-to-end | Highest setup cost; not warranted at portfolio scale; would force a single Prisma client across both repos. |

The HTTP choice maps to the architectural narrative: ledger-core's `postJournalEntry` IS the boundary; making it network-shaped makes the boundary legible.

## Wire format

### Request

```
POST {LEDGER_CORE_URL}/api/internal/journal-entries
Authorization: Bearer {LEDGER_CORE_INTERNAL_TOKEN}
Content-Type: application/json

{
  "entityCode": "NORTHWIND",
  "bookCode": "US_GAAP",
  "documentDate": "2026-03-31T00:00:00.000Z",
  "memo": "Adjustment for unbooked wire fee",
  "source": "MANUAL",
  "sourceSystem": "recon",
  "sourceRecordType": "bank-line-adjustment",
  "sourceRecordId": "<bank-line-uuid>",
  "lines": [
    { "accountCode": "1000", "credit": "50" },
    { "accountCode": "6500", "debit": "50" }
  ]
}
```

Decimals are serialized as **strings** (never JavaScript numbers) — preserves precision across the wire. Dates are ISO-8601.

### Response — success (200)

```json
{ "ok": true, "id": "uuid", "entryNumber": "NORTHWIND-US_GAAP-00042", "bookCode": "US_GAAP" }
```

### Response — failure (4xx/5xx)

```json
{ "ok": false, "error": { "code": "UNBALANCED", "message": "debits 50.00 ≠ credits 51.00" } }
```

Error codes (status):

| Code | Status | Meaning |
|---|---|---|
| `UNBALANCED` | 422 | Debits ≠ credits |
| `INVALID_LINE` | 422 | Line has both/neither debit and credit; or negative amount |
| `UNKNOWN_ACCOUNT` | 422 | accountCode doesn't resolve in this entity's chart |
| `UNKNOWN_ENTITY` | 422 | entityCode doesn't exist |
| `UNKNOWN_BOOK` | 422 | bookCode doesn't exist or is inactive |
| `ACCOUNT_BOOK_SCOPE` | 422 | Account isn't allowed for this book |
| `PERIOD_CLOSED` | 409 | (entity, book, period) is closed |
| `UNAUTHORIZED` | 401 / 503 | Missing/wrong token, or `INTERNAL_API_TOKEN` unset on ledger-core |
| `BAD_REQUEST` | 400 | Malformed body |
| `INTERNAL_ERROR` | 500 | Unexpected error inside ledger-core |
| `TRANSPORT_ERROR` | — | Recon-side: fetch threw or response wasn't JSON |

Recon's `LedgerCoreError` carries the same `code` + the message + the HTTP status, so Server Actions can branch on it.

## Configuration

### ledger-core

```
INTERNAL_API_TOKEN="<long random string>"
```

When unset, the endpoint refuses to run (503 with code=UNAUTHORIZED). Fail-closed.

### recon

```
LEDGER_CORE_URL="http://localhost:3000"   # default if unset
LEDGER_CORE_INTERNAL_TOKEN="<same value>"
```

When `LEDGER_CORE_INTERNAL_TOKEN` is unset, `postEntryViaLedgerCore` throws `LedgerCoreError("UNAUTHORIZED")` before attempting a fetch — no token, no call.

## When to use this bridge

**Use it for**: adjustment JEs created from inside recon. Right now that's the v0.2-beta `postAdjustmentAction` (for unmatched bank lines). When the AI-approval flow grows an "approve with adjustment" branch (e.g. AI proposed match is right amount-wise but needs a fee line), that calls this bridge too.

**Don't use it for**: reading from ledger-core. Reads go straight through recon's Prisma client against the shared DB. The bridge exists for WRITES only — those are the boundary-crossing operations.

## Failure handling

When the bridge throws `LedgerCoreError`, the calling Server Action surfaces the code + message to the user verbatim. That's deliberate: the message is the same one a human user would see if they'd typed the entry into ledger-core's UI directly. The boundary doesn't paper over substrate errors.

Common runtime failures:

| Symptom | Likely cause |
|---|---|
| `TRANSPORT_ERROR: Failed to reach ledger-core at ...` | ledger-core isn't running on the configured URL, or DNS/firewall issue |
| `UNAUTHORIZED: LEDGER_CORE_INTERNAL_TOKEN is not set` | Recon's `.env` is missing the token |
| `UNAUTHORIZED: Invalid or missing bearer token` (HTTP 401) | Token mismatch between the two repos' env vars |
| `UNAUTHORIZED: INTERNAL_API_TOKEN env var is not set` (HTTP 503) | ledger-core's `.env` is missing the token |
| `PERIOD_CLOSED` | The bank line's date falls inside a closed (entity, book, period) — month-end has happened. Adjustment must go to the next open period. |

## Testing

Bridge unit tests inject a mock fetch via `setFetchForTesting(fn)`. The mock returns whatever Response the test scenario needs. No live API hop, no Postgres, no ledger-core process required. See `tests/ledger-bridge.test.ts`.

The full end-to-end (recon → real ledger-core → real DB → entry written) is exercised by `scripts/smoke-test-ai.ts` plus a future `scripts/smoke-test-adjustment.ts` (TBD when env is wired).
