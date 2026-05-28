// Statement lock helper tests. Pure logic + mocked prisma — no DB.
//
// The helper's job is small: accept a statementId OR a bankLineId,
// resolve the statement (with tenant scope), and throw if status is
// RECONCILED. These tests verify each branch.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  assertStatementOpen,
  StatementReconciledError,
  StatementNotFoundError,
} from "../src/lib/statement-lock";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const STATEMENT_ID = "11111111-1111-1111-1111-111111111111";
const BANK_LINE_ID = "22222222-2222-2222-2222-222222222222";

function mockPrismaWith(args: {
  byStatement?: { id: string; status: string } | null;
  byLine?: { id: string; status: string } | null;
}): unknown {
  return {
    bankStatement: {
      findFirst: vi.fn().mockResolvedValue(args.byStatement ?? null),
    },
    bankStatementLine: {
      findFirst: vi.fn().mockResolvedValue(
        args.byLine
          ? { statement: args.byLine }
          : null
      ),
    },
  };
}

describe("assertStatementOpen — statementId path", () => {
  it("returns the statementId when status is OPEN", async () => {
    const prisma = mockPrismaWith({
      byStatement: { id: STATEMENT_ID, status: "OPEN" },
    });
    const r = await assertStatementOpen(prisma as never, {
      tenantId: TENANT_ID,
      statementId: STATEMENT_ID,
    });
    expect(r.statementId).toBe(STATEMENT_ID);
  });

  it("throws StatementReconciledError when status is RECONCILED", async () => {
    const prisma = mockPrismaWith({
      byStatement: { id: STATEMENT_ID, status: "RECONCILED" },
    });
    await expect(
      assertStatementOpen(prisma as never, {
        tenantId: TENANT_ID,
        statementId: STATEMENT_ID,
      })
    ).rejects.toThrow(StatementReconciledError);
  });

  it("throws StatementNotFoundError when the statement doesn't exist", async () => {
    const prisma = mockPrismaWith({ byStatement: null });
    await expect(
      assertStatementOpen(prisma as never, {
        tenantId: TENANT_ID,
        statementId: STATEMENT_ID,
      })
    ).rejects.toThrow(StatementNotFoundError);
  });
});

describe("assertStatementOpen — bankLineId path", () => {
  it("walks line → statement and returns statementId when OPEN", async () => {
    const prisma = mockPrismaWith({
      byLine: { id: STATEMENT_ID, status: "OPEN" },
    });
    const r = await assertStatementOpen(prisma as never, {
      tenantId: TENANT_ID,
      bankLineId: BANK_LINE_ID,
    });
    expect(r.statementId).toBe(STATEMENT_ID);
  });

  it("throws RECONCILED when the parent statement is locked", async () => {
    const prisma = mockPrismaWith({
      byLine: { id: STATEMENT_ID, status: "RECONCILED" },
    });
    await expect(
      assertStatementOpen(prisma as never, {
        tenantId: TENANT_ID,
        bankLineId: BANK_LINE_ID,
      })
    ).rejects.toThrow(StatementReconciledError);
  });

  it("throws NotFound when the line is missing (foreign tenant)", async () => {
    const prisma = mockPrismaWith({ byLine: null });
    await expect(
      assertStatementOpen(prisma as never, {
        tenantId: TENANT_ID,
        bankLineId: BANK_LINE_ID,
      })
    ).rejects.toThrow(StatementNotFoundError);
  });
});

describe("assertStatementOpen — input validation", () => {
  it("throws when neither statementId nor bankLineId is passed", async () => {
    const prisma = mockPrismaWith({});
    await expect(
      assertStatementOpen(prisma as never, { tenantId: TENANT_ID })
    ).rejects.toThrow(/statementId OR bankLineId/);
  });
});

describe("StatementReconciledError message", () => {
  it("includes a hint about reopening", () => {
    const err = new StatementReconciledError(STATEMENT_ID);
    expect(err.message).toMatch(/RECONCILED/);
    expect(err.message).toMatch(/[Rr]eopen/);
  });
});
