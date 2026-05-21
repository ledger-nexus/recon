"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { parseBankCsv, CsvParseError } from "@/lib/csv/parser";

export type UploadStatementState =
  | { ok?: undefined; error?: undefined }
  | { ok: true; statementId: string }
  | { ok: false; error: string };

// Server Action backing the /statements/new form. Parses the CSV, opens
// a BankStatement row, persists every line in one transaction.
//
// Idempotency note: this Server Action does NOT check for duplicate
// uploads. A real production system would compare filename + periodEnd
// + line-hash; for the v0.1 demo, uploading the same file twice is the
// user's problem.
export async function uploadStatementAction(
  _prev: UploadStatementState,
  formData: FormData
): Promise<UploadStatementState> {
  let statementId: string;
  try {
    const bankAccountId = String(formData.get("bankAccountId") ?? "");
    const filename = String(formData.get("filename") ?? "manual-paste.csv");
    const format = String(formData.get("format") ?? "GENERIC_CSV");
    const csvBody = String(formData.get("csvBody") ?? "");

    if (!bankAccountId) return { ok: false, error: "Bank account is required" };
    if (!csvBody.trim()) return { ok: false, error: "CSV body is empty" };

    let parsed;
    try {
      parsed = parseBankCsv(csvBody);
    } catch (e) {
      if (e instanceof CsvParseError) {
        return { ok: false, error: e.message };
      }
      throw e;
    }

    const created = await prisma.bankStatement.create({
      data: {
        bankAccountId,
        filename,
        format,
        rawPayload: csvBody,
        periodStart: parsed.meta.periodStart,
        periodEnd: parsed.meta.periodEnd,
        openingBalance: parsed.meta.openingBalance.toFixed(4),
        closingBalance: parsed.meta.closingBalance.toFixed(4),
        totalLines: parsed.lines.length,
        matchedLines: 0,
        pendingLines: parsed.lines.length,
        lines: {
          create: parsed.lines.map((l) => ({
            lineNo: l.lineNo,
            transactionDate: l.transactionDate,
            description: l.description,
            amount: l.amount.toFixed(4),
            runningBalance: l.runningBalance ? l.runningBalance.toFixed(4) : null,
          })),
        },
      },
      select: { id: true },
    });
    statementId = created.id;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }

  revalidatePath("/statements");
  revalidatePath("/", "layout");
  redirect(`/statements/${statementId}`);
}
