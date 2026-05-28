// Statement lock helper.
//
// One source of truth for "can this statement be mutated?". Used by
// every Server Action that writes through the matching pipeline
// (propose / decide / ignore / adjustment).
//
// Posture: the lock is a property of the BankStatement row
// (status=RECONCILED). When a statement is reconciled, every mutating
// path through the UI is refused — including the bulk-suggest button
// + per-line actions + ignore + adjustment. The user must reopen the
// statement first (admin action).

import type { PrismaClient } from "@prisma/client";

export class StatementReconciledError extends Error {
  constructor(public readonly statementId: string) {
    super(
      `This statement is RECONCILED — mutations are refused. Reopen it from the statement page first if you need to make changes.`
    );
    this.name = "StatementReconciledError";
  }
}

export class StatementNotFoundError extends Error {
  constructor(public readonly statementId: string) {
    super(`Statement ${statementId} not found in this tenant.`);
    this.name = "StatementNotFoundError";
  }
}

/**
 * Refuse the caller's mutation if the statement is RECONCILED.
 * Tenant-scopes the lookup at the same time (defensive — the action
 * already tenant-scopes its other reads, but threading the tenant
 * through here lets us reject foreign statements with the same error
 * shape).
 *
 * Pass either a statementId directly OR a bankLineId — in which case
 * we walk the line → statement.
 */
export async function assertStatementOpen(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    statementId?: string;
    bankLineId?: string;
  }
): Promise<{ statementId: string }> {
  if (!args.statementId && !args.bankLineId) {
    throw new Error(
      "assertStatementOpen requires statementId OR bankLineId — none provided"
    );
  }

  let statement: { id: string; status: string } | null;
  if (args.statementId) {
    statement = await prisma.bankStatement.findFirst({
      where: {
        id: args.statementId,
        bankAccount: { entity: { tenantId: args.tenantId } },
      },
      select: { id: true, status: true },
    });
  } else {
    const row = await prisma.bankStatementLine.findFirst({
      where: {
        id: args.bankLineId!,
        statement: {
          bankAccount: { entity: { tenantId: args.tenantId } },
        },
      },
      select: {
        statement: { select: { id: true, status: true } },
      },
    });
    statement = row?.statement ?? null;
  }

  if (!statement) {
    throw new StatementNotFoundError(args.statementId ?? args.bankLineId ?? "(unknown)");
  }
  if (statement.status === "RECONCILED") {
    throw new StatementReconciledError(statement.id);
  }
  return { statementId: statement.id };
}
