// Matching rules CRUD page.
//
// Heavy users build a library of "I know what this is" patterns over
// months of bookkeeping. This page is where they curate that library:
// see every rule sorted by priority, watch each rule's
// applicationCount climb as it fires on monthly statements, retire
// dead rules, add new ones.

import * as React from "react";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { getCurrentTenant } from "@/lib/auth/session";
import { RulesEditor } from "./rules-editor";
import { findRuleConflicts, type RuleConflict } from "@/lib/matching/rule-conflicts";

export default async function RulesPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) notFound();

  const rules = await prisma.matchingRule.findMany({
    where: { tenantId: tenant.id },
    orderBy: [{ isActive: "desc" }, { priority: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      descriptionRegex: true,
      amountMin: true,
      amountMax: true,
      actionType: true,
      counterAccountCode: true,
      memoTemplate: true,
      partyCode: true,
      priority: true,
      isActive: true,
      applicationCount: true,
      lastAppliedAt: true,
      createdBy: true,
      createdAt: true,
      entityId: true,
    },
  });

  const activeCount = rules.filter((r) => r.isActive).length;
  const totalApplications = rules.reduce((acc, r) => acc + r.applicationCount, 0);

  // Compute conflicts across the ACTIVE rule library. The detector
  // already filters inactive rules; we feed it the full list so
  // counts stay consistent if it ever evolves.
  const conflicts = findRuleConflicts(
    rules.map((r) => ({
      id: r.id,
      name: r.name,
      descriptionRegex: r.descriptionRegex,
      amountMin: r.amountMin ? r.amountMin.toString() : null,
      amountMax: r.amountMax ? r.amountMax.toString() : null,
      priority: r.priority,
      isActive: r.isActive,
      actionType: r.actionType,
      counterAccountCode: r.counterAccountCode,
      memoTemplate: r.memoTemplate,
      partyCode: r.partyCode,
      entityId: r.entityId,
    }))
  );

  // Index conflicts by rule id so each table row can flag itself.
  const conflictsByRule = new Map<string, RuleConflict[]>();
  for (const c of conflicts) {
    for (const id of [c.winnerId, c.loserId]) {
      const arr = conflictsByRule.get(id) ?? [];
      arr.push(c);
      conflictsByRule.set(id, arr);
    }
  }
  const ruleNameById = new Map(rules.map((r) => [r.id, r.name]));
  const shadowedLoserIds = new Set(
    conflicts.filter((c) => c.kind === "SHADOWED" || c.kind === "DUPLICATE").map((c) => c.loserId)
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">
          Matching rules
        </h1>
        <p className="mt-1 text-sm text-ink-500">
          Codify "I know what this is" patterns once; apply them to every future
          statement with one click. Active rules participate in the bulk apply
          run on each statement detail page. Soft-deleted rules survive in the
          DB for audit but stop firing.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-4">
            <Stat label="Active rules" value={String(activeCount)} />
            <Stat label="Total rules" value={String(rules.length)} />
            <Stat
              label="Total applications"
              value={totalApplications.toLocaleString()}
              hint="Lifetime fires across all statements."
            />
            <Stat
              label="Conflicts"
              value={String(conflicts.length)}
              hint={
                conflicts.length === 0
                  ? "No overlapping rules detected."
                  : "Rule pairs that overlap. Review the conflicts card below."
              }
              tone={conflicts.length > 0 ? "warning" : "neutral"}
            />
          </div>
        </CardContent>
      </Card>

      {conflicts.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Rule conflicts</CardTitle>
            <span className="text-xs text-ink-500">
              Rules whose patterns + amount ranges + entity scopes overlap. The
              engine resolves with first-match-wins by priority, but
              lower-priority rules may never fire as a result. SHADOWED means
              fully dead code; OVERLAP means both rules can match different
              lines but contest some.
            </span>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead>
                <tr>
                  <TH>Kind</TH>
                  <TH>Winner (fires first)</TH>
                  <TH>Loser (shadowed / contested)</TH>
                  <TH>Reason</TH>
                </tr>
              </THead>
              <TBody>
                {conflicts.map((c, i) => (
                  <TR key={i}>
                    <TD>
                      <Badge
                        tone={
                          c.kind === "DUPLICATE"
                            ? "negative"
                            : c.kind === "SHADOWED"
                              ? "warning"
                              : "info"
                        }
                      >
                        {c.kind}
                      </Badge>
                    </TD>
                    <TD className="font-medium text-ink-900">
                      {ruleNameById.get(c.winnerId) ?? c.winnerId}
                    </TD>
                    <TD className="text-ink-700">
                      {ruleNameById.get(c.loserId) ?? c.loserId}
                    </TD>
                    <TD className="text-xs text-ink-600">{c.reason}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Rules</CardTitle>
          <span className="text-xs text-ink-500">
            Sorted by priority (lower number = applied first). Click a row to edit.
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {rules.length === 0 ? (
            <div className="p-6 text-sm text-ink-500">
              No rules yet. Use the editor below to define your first one.
            </div>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH>Pattern</TH>
                  <TH>Action</TH>
                  <TH className="text-right">Priority</TH>
                  <TH className="text-right">Fires</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <TBody>
                {rules.map((r) => {
                  const ruleConflicts = conflictsByRule.get(r.id) ?? [];
                  const shadowed = shadowedLoserIds.has(r.id);
                  return (
                  <TR key={r.id}>
                    <TD>
                      <div className="flex items-center gap-1.5">
                        <div className="font-medium text-ink-900">{r.name}</div>
                        {shadowed ? (
                          <Badge tone="negative" title="This rule is shadowed by a higher-priority rule and will never fire.">
                            DEAD
                          </Badge>
                        ) : ruleConflicts.length > 0 ? (
                          <Badge tone="warning" title={ruleConflicts.map((c) => `${c.kind}: ${c.reason}`).join("\n\n")}>
                            CONFLICT
                          </Badge>
                        ) : null}
                      </div>
                      {r.lastAppliedAt ? (
                        <div className="text-[11px] text-ink-500">
                          last fired {r.lastAppliedAt.toISOString().slice(0, 10)}
                        </div>
                      ) : (
                        <div className="text-[11px] text-ink-400">never fired</div>
                      )}
                    </TD>
                    <TD className="font-mono text-[11px] text-ink-700">
                      /{r.descriptionRegex}/i
                      {r.amountMin != null || r.amountMax != null ? (
                        <div className="text-[10px] text-ink-500">
                          amount:{" "}
                          {r.amountMin != null ? r.amountMin.toString() : "−∞"}
                          {" to "}
                          {r.amountMax != null ? r.amountMax.toString() : "+∞"}
                        </div>
                      ) : null}
                    </TD>
                    <TD>
                      <Badge tone={r.actionType === "IGNORE" ? "neutral" : "info"}>
                        {r.actionType}
                      </Badge>
                      {r.actionType === "ADJUST" && r.counterAccountCode ? (
                        <div className="mt-0.5 text-[11px] text-ink-500">
                          counter: <span className="font-mono">{r.counterAccountCode}</span>
                        </div>
                      ) : null}
                    </TD>
                    <TD className="text-right text-ink-700">{r.priority}</TD>
                    <TD className="text-right amount-cell text-ink-700">
                      {r.applicationCount.toLocaleString()}
                    </TD>
                    <TD>
                      <Badge tone={r.isActive ? "positive" : "neutral"}>
                        {r.isActive ? "ACTIVE" : "INACTIVE"}
                      </Badge>
                    </TD>
                  </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Edit / create</CardTitle>
          <span className="text-xs text-ink-500">
            Patterns are regex (case-insensitive). Avoid nested unbounded
            quantifiers like <span className="font-mono">(a+)+</span> — those
            are ReDoS-prone and the validator will reject them.
          </span>
        </CardHeader>
        <CardContent>
          <RulesEditor
            rules={rules.map((r) => ({
              id: r.id,
              name: r.name,
              descriptionRegex: r.descriptionRegex,
              amountMin: r.amountMin ? Number(r.amountMin.toString()) : null,
              amountMax: r.amountMax ? Number(r.amountMax.toString()) : null,
              actionType: r.actionType,
              counterAccountCode: r.counterAccountCode,
              memoTemplate: r.memoTemplate,
              partyCode: r.partyCode,
              priority: r.priority,
              isActive: r.isActive,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "warning";
}) {
  const valueClass =
    tone === "warning" ? "text-amber-700" : "text-ink-900";
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
        {label}
      </div>
      <div className={`mt-0.5 text-2xl font-semibold tabular-nums ${valueClass}`}>
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] text-ink-500">{hint}</div> : null}
    </div>
  );
}
