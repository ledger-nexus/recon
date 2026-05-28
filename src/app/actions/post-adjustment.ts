"use server";

// Single-counter adjustment shim. The substantive logic lives in
// postMultiLineAdjustmentAction — this function preserves the simpler
// 2-line API shape for existing callers (the per-line UI quick form,
// any external consumer wired to v0.2-beta's contract).
//
// History: v0.2-beta shipped a two-line action (cash + one counter
// computed from the bank-line sign). v1.1 lifted the multi-line case
// (split deposits, bundled payments). Rather than fork the post + auth
// logic, this shim looks up the bank line's sign once, builds a
// single-element counter array on the opposite side, then delegates.
//
// Sign convention preserved end-to-end:
//   - Bank deposit (+amount) → cash debit + counter credit
//   - Bank withdrawal (-amount) → cash credit + counter debit
//
// New code should call postMultiLineAdjustmentAction directly so it
// can model the actual multi-line shape of the underlying JE (split
// fees, bundled vendor payments, etc.).

import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import {
  postMultiLineAdjustmentAction,
  type PostMultiLineAdjustmentState,
} from "./post-multi-line-adjustment";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";

export interface PostAdjustmentInput {
  bankLineId: string;
  counterAccountCode: string;
  memo?: string;
  partyCode?: string;
  bookCode?: string;
  /** Retained for backward compat — never trusted as identity. */
  postedBy?: string;
}

export type PostAdjustmentState = PostMultiLineAdjustmentState;

export async function postAdjustmentAction(
  input: PostAdjustmentInput
): Promise<PostAdjustmentState> {
  try {
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    // Look up the bank line's sign so we can build the single-counter
    // array on the opposite side. Tenant-scoped — same security
    // posture as the multi-line action itself.
    const bankLine = await prisma.bankStatementLine.findFirst({
      where: {
        id: input.bankLineId,
        statement: { bankAccount: { entity: { tenantId: tenant.id } } },
      },
      select: { amount: true },
    });
    if (!bankLine) {
      return { ok: false, message: "Bank line not found in this tenant" };
    }
    const signed = new Decimal(bankLine.amount.toString());
    if (signed.isZero()) {
      return { ok: false, message: "Cannot post a $0 adjustment" };
    }

    // Bank deposit (+) → counter is CREDIT. Bank withdrawal (-) →
    // counter is DEBIT. The validator inside the multi-line action
    // rejects unbalanced inputs as a backstop.
    const counterSide = signed.isPositive() ? "CREDIT" : "DEBIT";
    return postMultiLineAdjustmentAction({
      bankLineId: input.bankLineId,
      counterLines: [
        {
          accountCode: input.counterAccountCode,
          side: counterSide,
          amount: signed.abs(),
          partyCode: input.partyCode ?? null,
        },
      ],
      memo: input.memo,
      bookCode: input.bookCode,
    });
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, message: "You must be signed in to post an adjustment." };
    }
    if (e instanceof NoTenantSelectedError) {
      return { ok: false, message: e.message };
    }
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error",
    };
  }
}
