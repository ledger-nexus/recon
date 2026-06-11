// Unit tests for the importNsReconAction Server Action.
//
// Mocks auth/session + prisma + the orchestrator so the suite runs
// without a live DB. We test the action's wrapping logic — parse +
// validate + build resolvers + call orchestrator + format summary —
// not the orchestrator itself (covered in PR #18 + #19).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_USER_ID = "user-1";
const FAKE_TENANT_ID = "tenant-1";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const requireCurrentUser = vi.fn(async () => ({
  id: FAKE_USER_ID,
  email: "test@example.test",
  displayName: "Test",
}));
const requireCurrentTenant = vi.fn(async () => ({
  id: FAKE_TENANT_ID,
  slug: "test-tenant",
  name: "Test Tenant",
  role: "OWNER",
}));

class FakeNotAuthenticatedError extends Error {}
class FakeNoTenantSelectedError extends Error {}

vi.mock("@/lib/auth/session", () => ({
  requireCurrentUser: () => requireCurrentUser(),
  requireCurrentTenant: () => requireCurrentTenant(),
  NotAuthenticatedError: FakeNotAuthenticatedError,
  NoTenantSelectedError: FakeNoTenantSelectedError,
}));

// Mocked prisma — minimal surface for the resolver callbacks.
interface MockPrisma {
  legalEntity: { findFirst: ReturnType<typeof vi.fn> };
  account: { findFirst: ReturnType<typeof vi.fn> };
  journalEntry: { findFirst: ReturnType<typeof vi.fn> };
}

const makeMockPrisma = (
  overrides: {
    entity?: { id: string } | null;
    account?: { id: string } | null;
    journalEntry?:
      | { lines: Array<{ id: string; lineNo: number; account: { subtype: string | null } }> }
      | null;
  } = {}
): MockPrisma => ({
  legalEntity: {
    findFirst: vi
      .fn()
      .mockResolvedValue(overrides.entity ?? { id: "entity-1" }),
  },
  account: {
    findFirst: vi.fn().mockResolvedValue(overrides.account ?? { id: "account-1" }),
  },
  journalEntry: {
    findFirst: vi.fn().mockResolvedValue(
      overrides.journalEntry ?? {
        lines: [
          { id: "je-line-1", lineNo: 1, account: { subtype: "BANK" } },
          { id: "je-line-2", lineNo: 2, account: { subtype: "REVENUE" } },
        ],
      }
    ),
  },
});

let mockPrisma: MockPrisma;
vi.mock("@/lib/db", () => ({
  get prisma() {
    return mockPrisma;
  },
}));

const importFromNsRecon = vi.fn();
vi.mock("@/lib/mappers/netsuite", () => ({
  importFromNsRecon: (...args: unknown[]) => importFromNsRecon(...args),
}));

const VALID_BUNDLE_JSON = JSON.stringify({
  exported_at: "2026-06-05T00:00:00Z",
  account_id: "ns-acct-1",
  bank_accounts: [
    {
      internalid: "ba-1",
      name: "Test Account",
      gl_account_id: { internalid: "acct-1000" },
      subsidiary: { internalid: "sub-1" },
      currency: "USD",
    },
  ],
  statements: [
    {
      internalid: "stmt-1",
      bank_account: { internalid: "ba-1" },
      period_start: "2026-03-01",
      period_end: "2026-03-31",
      opening_balance: 0,
      closing_balance: 1000,
      currency: "USD",
      lines: [],
    },
  ],
});

describe("importNsReconAction", () => {
  beforeEach(() => {
    mockPrisma = makeMockPrisma();
    requireCurrentUser.mockResolvedValue({
      id: FAKE_USER_ID,
      email: "test@example.test",
      displayName: "Test",
    });
    requireCurrentTenant.mockResolvedValue({
      id: FAKE_TENANT_ID,
      slug: "test-tenant",
      name: "Test Tenant",
      role: "OWNER",
    });
    importFromNsRecon.mockResolvedValue({
      arrangements: [],
      statements: [
        {
          nsStatementInternalId: "stmt-1",
          bankStatementId: "stmt-db-1",
          wasDuplicate: false,
          linesCreated: 1,
          matchesCreated: 1,
          matchesSkipped: 0,
          warnings: [],
        },
      ],
      errors: [],
      totals: {
        statementsProcessed: 1,
        statementsCreated: 1,
        statementsSkipped: 0,
        statementsErrored: 0,
        linesCreated: 1,
        matchesCreated: 1,
        matchesSkipped: 0,
        warningCount: 0,
      },
    });
  });

  afterEach(() => {
    importFromNsRecon.mockReset();
  });

  it("happy path — parse, call orchestrator, return formatted summary", async () => {
    const { importNsReconAction } = await import(
      "../src/app/actions/import-ns-recon"
    );
    const state = await importNsReconAction({ bundleJson: VALID_BUNDLE_JSON });

    expect(state.ok).toBe(true);
    expect(state.message).toContain("1 statement");
    expect(state.message).toContain("1 created");
    expect(state.message).toContain("1 pre-existing match");
    expect(state.result?.totals.statementsCreated).toBe(1);
    expect(importFromNsRecon).toHaveBeenCalledTimes(1);
  });

  it("returns 400-style state on invalid JSON", async () => {
    const { importNsReconAction } = await import(
      "../src/app/actions/import-ns-recon"
    );
    const state = await importNsReconAction({ bundleJson: "{ not json" });
    expect(state.ok).toBe(false);
    expect(state.message).toContain("parse");
    expect(importFromNsRecon).not.toHaveBeenCalled();
  });

  it("returns 400-style state when bundle is missing required top-level fields", async () => {
    const { importNsReconAction } = await import(
      "../src/app/actions/import-ns-recon"
    );
    const state = await importNsReconAction({
      bundleJson: JSON.stringify({ exported_at: "x" }),
    });
    expect(state.ok).toBe(false);
    expect(state.message).toContain("missing required");
    expect(importFromNsRecon).not.toHaveBeenCalled();
  });

  it("rejects when not authenticated", async () => {
    requireCurrentUser.mockRejectedValueOnce(new FakeNotAuthenticatedError());
    const { importNsReconAction } = await import(
      "../src/app/actions/import-ns-recon"
    );
    const state = await importNsReconAction({ bundleJson: VALID_BUNDLE_JSON });
    expect(state.ok).toBe(false);
    expect(state.message).toBe("Not authenticated.");
  });

  it("rejects when no tenant selected", async () => {
    requireCurrentTenant.mockRejectedValueOnce(new FakeNoTenantSelectedError());
    const { importNsReconAction } = await import(
      "../src/app/actions/import-ns-recon"
    );
    const state = await importNsReconAction({ bundleJson: VALID_BUNDLE_JSON });
    expect(state.ok).toBe(false);
    expect(state.message).toBe("No tenant selected.");
  });

  it("entity resolver uses NSSUB-{id} default convention", async () => {
    const { importNsReconAction } = await import(
      "../src/app/actions/import-ns-recon"
    );
    await importNsReconAction({ bundleJson: VALID_BUNDLE_JSON });

    const passedInput = importFromNsRecon.mock.calls[0][1];
    await passedInput.resolveEntityId({ nsSubsidiaryInternalId: "sub-99" });
    expect(mockPrisma.legalEntity.findFirst).toHaveBeenCalledWith({
      where: { code: "NSSUB-sub-99", tenantId: FAKE_TENANT_ID },
      select: { id: true },
    });
  });

  it("entity resolver uses caller-provided map when available", async () => {
    const { importNsReconAction } = await import(
      "../src/app/actions/import-ns-recon"
    );
    await importNsReconAction({
      bundleJson: VALID_BUNDLE_JSON,
      subsidiaryEntityCodeMap: { "sub-1": "CUSTOM_ENTITY" },
    });

    const passedInput = importFromNsRecon.mock.calls[0][1];
    await passedInput.resolveEntityId({ nsSubsidiaryInternalId: "sub-1" });
    expect(mockPrisma.legalEntity.findFirst).toHaveBeenCalledWith({
      where: { code: "CUSTOM_ENTITY", tenantId: FAKE_TENANT_ID },
      select: { id: true },
    });
  });

  it("bank GL account resolver queries by NS lineage triple", async () => {
    const { importNsReconAction } = await import(
      "../src/app/actions/import-ns-recon"
    );
    await importNsReconAction({ bundleJson: VALID_BUNDLE_JSON });

    const passedInput = importFromNsRecon.mock.calls[0][1];
    await passedInput.resolveBankGlAccountId({
      nsGlAccountInternalId: "acct-1000",
    });
    expect(mockPrisma.account.findFirst).toHaveBeenCalledWith({
      where: {
        sourceSystem: "netsuite",
        sourceRecordType: "Account",
        sourceRecordId: "acct-1000",
      },
      select: { id: true },
    });
  });

  it("journal-line resolver picks the BANK-subtype line preferentially", async () => {
    const { importNsReconAction } = await import(
      "../src/app/actions/import-ns-recon"
    );
    await importNsReconAction({ bundleJson: VALID_BUNDLE_JSON });

    const passedInput = importFromNsRecon.mock.calls[0][1];
    const id = await passedInput.resolveJournalLineId({
      matchedTransactionType: "payment",
      matchedTransactionInternalId: "pay-1",
    });
    // Mock returns lines: [BANK, REVENUE]; resolver picks the BANK one.
    expect(id).toBe("je-line-1");
  });

  it("journal-line resolver falls back to first lineNo when no BANK subtype found", async () => {
    mockPrisma = makeMockPrisma({
      journalEntry: {
        lines: [
          { id: "je-line-revenue", lineNo: 1, account: { subtype: "REVENUE" } },
          { id: "je-line-receivable", lineNo: 2, account: { subtype: "AR" } },
        ],
      },
    });
    const { importNsReconAction } = await import(
      "../src/app/actions/import-ns-recon"
    );
    await importNsReconAction({ bundleJson: VALID_BUNDLE_JSON });

    const passedInput = importFromNsRecon.mock.calls[0][1];
    const id = await passedInput.resolveJournalLineId({
      matchedTransactionType: "payment",
      matchedTransactionInternalId: "pay-1",
    });
    // First by lineNo (lineNo=1 is REVENUE; defensive fallback).
    expect(id).toBe("je-line-revenue");
  });

  // Note: the null-resolver case (JE not yet imported → returns null)
  // is exercised by the orchestrator's own tests (PR #18 mocked +
  // PR #19 real DB). The action just calls the resolver; null
  // propagation is the orchestrator's responsibility.

  it("forwards the orchestrator's full result on state.result for UI rendering", async () => {
    importFromNsRecon.mockResolvedValueOnce({
      arrangements: [],
      statements: [
        {
          nsStatementInternalId: "stmt-1",
          bankStatementId: "stmt-db-1",
          wasDuplicate: false,
          linesCreated: 5,
          matchesCreated: 3,
          matchesSkipped: 2,
          warnings: ["Statement stmt-1: only 60% matched"],
        },
      ],
      errors: [
        {
          nsStatementInternalId: "stmt-bad",
          message: "Could not resolve LegalEntity",
        },
      ],
      totals: {
        statementsProcessed: 2,
        statementsCreated: 1,
        statementsSkipped: 0,
        statementsErrored: 1,
        linesCreated: 5,
        matchesCreated: 3,
        matchesSkipped: 2,
        warningCount: 1,
      },
    });

    const { importNsReconAction } = await import(
      "../src/app/actions/import-ns-recon"
    );
    const state = await importNsReconAction({ bundleJson: VALID_BUNDLE_JSON });

    expect(state.ok).toBe(true);
    expect(state.result?.statements).toHaveLength(1);
    expect(state.result?.errors).toHaveLength(1);
    expect(state.message).toContain("1 created");
    expect(state.message).toContain("1 errored");
    expect(state.message).toContain("2 skipped (GL not yet imported)");
    expect(state.message).toContain("1 warning");
  });
});
