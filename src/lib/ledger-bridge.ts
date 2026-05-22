// The ledger-core bridge — recon's only path into ledger-core's
// `postJournalEntry`.
//
// Architecture: recon does NOT import ledger-core source. It POSTs to
// ledger-core's `/api/internal/journal-entries` endpoint, which is the
// single network entry point onto the ledger. This matches the framing
// in both repos' CLAUDE.md files: "every ledger write goes through
// postJournalEntry." Here that boundary is an HTTP one.
//
// Why HTTP instead of a relative-path source import:
//   - Each repo owns its own generated Prisma client. A cross-repo
//     in-process call requires either an unsafe type cast or expanding
//     recon's schema mirror past the point of clean ownership.
//   - HTTP gives us a wire-format contract that's audited, mockable, and
//     deployable independently.
//   - The boundary IS postJournalEntry — making it network-shaped makes
//     the architecture legible.
//
// Configuration (set in recon's .env):
//   LEDGER_CORE_URL          — e.g. http://localhost:3000 in dev
//   LEDGER_CORE_INTERNAL_TOKEN — shared with ledger-core's
//                                INTERNAL_API_TOKEN

import { Decimal } from "decimal.js";

const DEFAULT_LEDGER_CORE_URL = "http://localhost:3000";

export interface LedgerJournalLine {
  accountCode: string;
  debit?: Decimal | string | number;
  credit?: Decimal | string | number;
  description?: string;
  partyCode?: string;
  itemCode?: string;
  transactionAmount?: Decimal | string | number;
  reportingAmount?: Decimal | string | number;
  extensions?: Record<string, unknown>;
}

export interface LedgerJournalEntryInput {
  entityCode: string;
  bookCode?: string;
  currencyCode?: string;
  fxRate?: Decimal | string | number;
  documentDate: Date;
  postingDate?: Date;
  memo: string;
  source?: "MANUAL" | "AI_APPROVED" | "IMPORT" | "SYSTEM";
  lines: LedgerJournalLine[];
  sourceSystem?: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
  sourcePayload?: unknown;
  mappingVersion?: string;
  extensions?: Record<string, unknown>;
}

export interface LedgerPostResult {
  id: string;
  entryNumber: string;
  bookCode: string;
}

// Error code matches ledger-core's route handler. Branchable in callers.
export type LedgerErrorCode =
  | "UNBALANCED"
  | "INVALID_LINE"
  | "UNKNOWN_ACCOUNT"
  | "UNKNOWN_ENTITY"
  | "UNKNOWN_BOOK"
  | "PERIOD_CLOSED"
  | "ACCOUNT_BOOK_SCOPE"
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "INTERNAL_ERROR"
  | "TRANSPORT_ERROR";

export class LedgerCoreError extends Error {
  constructor(public code: LedgerErrorCode, message: string, public status?: number) {
    super(message);
    this.name = "LedgerCoreError";
  }
}

function serializeDecimal(v: Decimal | string | number | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (v instanceof Decimal) return v.toFixed();
  return String(v);
}

function serializeLine(l: LedgerJournalLine): Record<string, unknown> {
  return {
    accountCode: l.accountCode,
    debit: serializeDecimal(l.debit),
    credit: serializeDecimal(l.credit),
    description: l.description,
    partyCode: l.partyCode,
    itemCode: l.itemCode,
    transactionAmount: serializeDecimal(l.transactionAmount),
    reportingAmount: serializeDecimal(l.reportingAmount),
    extensions: l.extensions,
  };
}

// Allow tests to inject a mock fetch. Pass null to restore globalThis.fetch.
let _fetchOverride: typeof fetch | null = null;
export function setFetchForTesting(fn: typeof fetch | null): void {
  _fetchOverride = fn;
}

export async function postEntryViaLedgerCore(
  input: LedgerJournalEntryInput
): Promise<LedgerPostResult> {
  const baseUrl = process.env.LEDGER_CORE_URL ?? DEFAULT_LEDGER_CORE_URL;
  const token = process.env.LEDGER_CORE_INTERNAL_TOKEN;
  if (!token) {
    throw new LedgerCoreError(
      "UNAUTHORIZED",
      "LEDGER_CORE_INTERNAL_TOKEN is not set in recon's env — cannot post to ledger-core"
    );
  }

  const body = {
    entityCode: input.entityCode,
    bookCode: input.bookCode,
    currencyCode: input.currencyCode,
    fxRate: serializeDecimal(input.fxRate),
    documentDate: input.documentDate.toISOString(),
    postingDate: input.postingDate?.toISOString(),
    memo: input.memo,
    source: input.source,
    lines: input.lines.map(serializeLine),
    sourceSystem: input.sourceSystem,
    sourceRecordType: input.sourceRecordType,
    sourceRecordId: input.sourceRecordId,
    sourcePayload: input.sourcePayload,
    mappingVersion: input.mappingVersion,
    extensions: input.extensions,
  };

  const fetchFn = _fetchOverride ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}/api/internal/journal-entries`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new LedgerCoreError(
      "TRANSPORT_ERROR",
      `Failed to reach ledger-core at ${baseUrl}: ${e instanceof Error ? e.message : "Unknown error"}`
    );
  }

  type ApiResponse =
    | { ok: true; id: string; entryNumber: string; bookCode: string }
    | { ok: false; error: { code: LedgerErrorCode; message: string } };

  let payload: ApiResponse;
  try {
    payload = (await res.json()) as ApiResponse;
  } catch {
    throw new LedgerCoreError(
      "TRANSPORT_ERROR",
      `ledger-core returned non-JSON response (status ${res.status})`,
      res.status
    );
  }

  if (!payload.ok) {
    throw new LedgerCoreError(payload.error.code, payload.error.message, res.status);
  }

  return {
    id: payload.id,
    entryNumber: payload.entryNumber,
    bookCode: payload.bookCode,
  };
}
