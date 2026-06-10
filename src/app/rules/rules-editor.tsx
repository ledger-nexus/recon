"use client";

// Rules editor — client component.
//
// Two modes in one form:
//
//   - Add: blank form. Submit calls createMatchingRuleAction.
//   - Edit: select an existing rule from the dropdown; form populates
//     with its current values. Submit calls updateMatchingRuleAction.
//
// The "Deactivate" button (Edit mode only) calls
// deleteMatchingRuleAction — soft-delete; the rule sticks around in
// the DB and the list page shows it as INACTIVE.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Select, Label } from "@/components/ui/input";
import {
  createMatchingRuleAction,
  updateMatchingRuleAction,
  deleteMatchingRuleAction,
  type RuleActionType,
} from "@/app/actions/matching-rules";

interface RuleRow {
  id: string;
  name: string;
  descriptionRegex: string;
  amountMin: number | null;
  amountMax: number | null;
  actionType: RuleActionType;
  counterAccountCode: string | null;
  memoTemplate: string | null;
  partyCode: string | null;
  priority: number;
  isActive: boolean;
}

export function RulesEditor({ rules }: { rules: RuleRow[] }) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Hash bumps after a submit to force form-state reset (we re-mount the form
  // by changing its key so defaultValue inputs pick up the freshly-fetched
  // rule list on the server side after revalidatePath fires).
  const [resetKey, setResetKey] = useState(0);

  const selected = rules.find((r) => r.id === selectedId);

  function onSubmit(formData: FormData) {
    setMessage(null);
    const name = String(formData.get("name") ?? "").trim();
    const descriptionRegex = String(formData.get("descriptionRegex") ?? "");
    const actionType = String(formData.get("actionType") ?? "ADJUST") as RuleActionType;
    const counterAccountCodeRaw = String(formData.get("counterAccountCode") ?? "").trim();
    const memoTemplateRaw = String(formData.get("memoTemplate") ?? "").trim();
    const partyCodeRaw = String(formData.get("partyCode") ?? "").trim();
    const priority = parseInt(String(formData.get("priority") ?? "100"), 10);
    const amountMinRaw = String(formData.get("amountMin") ?? "").trim();
    const amountMaxRaw = String(formData.get("amountMax") ?? "").trim();

    const amountMin = amountMinRaw === "" ? null : parseFloat(amountMinRaw);
    const amountMax = amountMaxRaw === "" ? null : parseFloat(amountMaxRaw);

    startTransition(async () => {
      const result = selected
        ? await updateMatchingRuleAction({
            ruleId: selected.id,
            name,
            descriptionRegex,
            actionType,
            counterAccountCode: actionType === "ADJUST" ? counterAccountCodeRaw : null,
            memoTemplate: memoTemplateRaw || null,
            partyCode: partyCodeRaw || null,
            priority,
            amountMin,
            amountMax,
          })
        : await createMatchingRuleAction({
            name,
            descriptionRegex,
            actionType,
            counterAccountCode: actionType === "ADJUST" ? counterAccountCodeRaw : null,
            memoTemplate: memoTemplateRaw || null,
            partyCode: partyCodeRaw || null,
            priority,
            amountMin,
            amountMax,
          });
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok) {
        // Reset form, return to "Add" mode.
        setSelectedId("");
        setResetKey((k) => k + 1);
      }
    });
  }

  function onDeactivate() {
    if (!selected) return;
    if (!window.confirm(`Deactivate rule '${selected.name}'? It will stop firing on future statements.`)) return;
    startTransition(async () => {
      const result = await deleteMatchingRuleAction(selected.id);
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok) {
        setSelectedId("");
        setResetKey((k) => k + 1);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Label htmlFor="rule-select" className="text-[11px] uppercase tracking-wider text-ink-500">
            Editing
          </Label>
          <Select
            id="rule-select"
            value={selectedId}
            onChange={(e) => {
              setSelectedId(e.target.value);
              setMessage(null);
              setResetKey((k) => k + 1);
            }}
            className="mt-1"
          >
            <option value="">— New rule —</option>
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.isActive ? "" : "(inactive) "}
                {r.name} · priority {r.priority}
              </option>
            ))}
          </Select>
        </div>
        {selected ? (
          <Button variant="ghost" onClick={onDeactivate} disabled={pending}>
            Deactivate
          </Button>
        ) : null}
      </div>

      <form key={resetKey} action={onSubmit} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input
              name="name"
              required
              defaultValue={selected?.name ?? ""}
              placeholder="Stripe payouts → AR"
            />
          </Field>
          <Field label="Priority (lower = applied first)">
            <Input
              name="priority"
              required
              type="number"
              min="1"
              defaultValue={selected?.priority ?? 100}
            />
          </Field>
          <Field label="Description regex (case-insensitive)" wide>
            <Input
              name="descriptionRegex"
              required
              defaultValue={selected?.descriptionRegex ?? ""}
              placeholder="STRIPE PAYOUT"
              className="font-mono"
            />
          </Field>
          <Field label="Action">
            <Select
              name="actionType"
              required
              defaultValue={selected?.actionType ?? "ADJUST"}
            >
              <option value="ADJUST">ADJUST (post a JE)</option>
              <option value="IGNORE">IGNORE (mark line ignored)</option>
            </Select>
          </Field>
          <Field label="Counter account code (required for ADJUST)">
            <Input
              name="counterAccountCode"
              defaultValue={selected?.counterAccountCode ?? ""}
              placeholder="1200"
              className="font-mono"
            />
          </Field>
          <Field label="Amount min (signed; negative = withdrawal)">
            <Input
              name="amountMin"
              type="number"
              step="0.01"
              defaultValue={selected?.amountMin ?? ""}
              placeholder="leave blank for no min"
              className="amount-cell"
            />
          </Field>
          <Field label="Amount max (signed)">
            <Input
              name="amountMax"
              type="number"
              step="0.01"
              defaultValue={selected?.amountMax ?? ""}
              placeholder="leave blank for no max"
              className="amount-cell"
            />
          </Field>
          <Field label="Party code (optional)">
            <Input
              name="partyCode"
              defaultValue={selected?.partyCode ?? ""}
              placeholder="STRIPE_INC"
              className="font-mono"
            />
          </Field>
          <Field label="Priority hint">
            <div className="rounded-md border border-ink-100 bg-ink-50 px-3 py-2 text-[11px] text-ink-600">
              10–49: highly specific rules (exact merchant + amount).<br />
              50–99: typical merchant patterns.<br />
              100+: catch-alls.
            </div>
          </Field>
          <Field label="Memo template (supports {description} {date} {ruleName})" wide>
            <Textarea
              name="memoTemplate"
              rows={2}
              defaultValue={selected?.memoTemplate ?? ""}
              placeholder="{ruleName}: {description} on {date}"
            />
          </Field>
        </div>

        {message ? (
          <div
            className={`rounded-md p-2 text-xs ${
              message.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"
            }`}
          >
            {message.text}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          {selected ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSelectedId("");
                setMessage(null);
                setResetKey((k) => k + 1);
              }}
              disabled={pending}
            >
              Cancel edit
            </Button>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : selected ? "Save changes" : "Create rule"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 ${wide ? "col-span-2" : ""}`}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
        {label}
      </span>
      {children}
    </label>
  );
}
