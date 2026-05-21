"use client";

import { useFormState, useFormStatus } from "react-dom";
import { uploadStatementAction, type UploadStatementState } from "@/app/actions/upload-statement";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface BankAccountOption {
  id: string;
  code: string;
  displayName: string;
}

const initialState: UploadStatementState = {};

export function UploadStatementForm({ bankAccounts }: { bankAccounts: BankAccountOption[] }) {
  const [state, formAction] = useFormState(uploadStatementAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Upload bank statement</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="bankAccountId">Bank account</Label>
            <Select name="bankAccountId" id="bankAccountId" required defaultValue="">
              <option value="" disabled>
                — select —
              </option>
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.displayName}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="filename">Filename (informational)</Label>
            <Input
              name="filename"
              id="filename"
              placeholder="march-2026.csv"
              defaultValue="bank-statement.csv"
            />
          </div>
          <div>
            <Label htmlFor="format">Format</Label>
            <Select name="format" id="format" defaultValue="GENERIC_CSV">
              <option value="GENERIC_CSV">GENERIC_CSV</option>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="csvBody">CSV body</Label>
            <Textarea
              name="csvBody"
              id="csvBody"
              required
              rows={12}
              placeholder={`"Period: 2026-03-01 to 2026-03-31"\n"Opening Balance: 1000.00"\n"Closing Balance: 950.00"\n"Date","Description","Amount","Running Balance"\n"2026-03-15","ACH CREDIT - ACME CORP",100,1100\n"2026-03-20","WIRE OUT - VENDOR",-150,950`}
            />
            <p className="mt-1 text-[11px] text-ink-500">
              Header rows for opening/closing balance + period, then a CSV table with Date, Description, Amount, optional Running Balance.
            </p>
          </div>
        </CardContent>
      </Card>

      {state?.ok === false && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="font-medium">Upload failed: </span>
          {state.error}
        </div>
      )}

      <div className="flex justify-end">
        <SubmitButton />
      </div>
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Parsing…" : "Upload + parse"}
    </Button>
  );
}
