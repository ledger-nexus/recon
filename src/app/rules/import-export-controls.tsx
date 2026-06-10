"use client";

// Rule import/export controls for the /rules page.
//
// Layout:
//   - Export button: triggers exportMatchingRulesAction, prompts a
//     download of the returned JSON.
//   - Import section: file picker → preview (server action) →
//     commit (server action). Operator sees per-rule NEW/DUPLICATE/
//     ISSUE classification before any DB write.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  exportMatchingRulesAction,
  previewImportAction,
  commitImportAction,
  type ExportState,
  type PreviewImportState,
} from "@/app/actions/rule-import-export";

export function ImportExportControls() {
  const [pending, startTransition] = useTransition();
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [importRaw, setImportRaw] = useState<string | null>(null);
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewImportState | null>(null);
  const [commitResult, setCommitResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  function onExport() {
    setExportMsg(null);
    startTransition(async () => {
      const result: ExportState = await exportMatchingRulesAction();
      if (!result.ok || !result.payload) {
        setExportMsg(result.message);
        return;
      }
      // Trigger a download in the browser.
      const blob = new Blob([JSON.stringify(result.payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `recon-rules-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportMsg(result.message);
    });
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setPreview(null);
    setCommitResult(null);
    const file = e.target.files?.[0];
    if (!file) {
      setImportRaw(null);
      setImportFileName(null);
      return;
    }
    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      setImportRaw(typeof reader.result === "string" ? reader.result : null);
    };
    reader.readAsText(file);
  }

  function onPreview() {
    if (!importRaw) return;
    setPreview(null);
    setCommitResult(null);
    startTransition(async () => {
      const result = await previewImportAction(importRaw);
      setPreview(result);
    });
  }

  function onCommit() {
    if (!importRaw || !preview?.ok || !preview.plan) return;
    setCommitResult(null);
    startTransition(async () => {
      const result = await commitImportAction(importRaw);
      setCommitResult({ ok: result.ok, message: result.message });
      if (result.ok) {
        setImportRaw(null);
        setImportFileName(null);
        setPreview(null);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Export */}
      <div className="flex items-center justify-between rounded-md border border-ink-200 p-3">
        <div>
          <div className="text-sm font-medium text-ink-900">Export library</div>
          <div className="text-[11px] text-ink-500">
            Downloads all ACTIVE rules as JSON. Tenant-local metadata
            (id, applicationCount, createdBy) is omitted so the file
            ports cleanly to other tenants.
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={onExport} disabled={pending}>
          {pending && exportMsg === null ? "Exporting…" : "Export"}
        </Button>
      </div>
      {exportMsg ? (
        <div className="text-[11px] text-ink-600">{exportMsg}</div>
      ) : null}

      {/* Import */}
      <div className="flex flex-col gap-2 rounded-md border border-ink-200 p-3">
        <div className="text-sm font-medium text-ink-900">Import library</div>
        <div className="text-[11px] text-ink-500">
          Upload a previously-exported JSON file. The server validates the
          schema, re-checks regex patterns, and classifies each incoming
          rule as NEW / DUPLICATE / ISSUE. Nothing is created until you
          click Commit.
        </div>
        <div className="flex items-center gap-2">
          <input
            type="file"
            accept="application/json,.json"
            onChange={onFileChange}
            disabled={pending}
            className="block text-xs text-ink-700 file:mr-2 file:rounded-md file:border-0 file:bg-ink-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-ink-700 file:hover:bg-ink-200"
          />
          {importFileName ? (
            <span className="text-[11px] font-mono text-ink-500">
              {importFileName}
            </span>
          ) : null}
        </div>
        {importRaw ? (
          <Button size="sm" variant="outline" onClick={onPreview} disabled={pending}>
            {pending && !preview ? "Previewing…" : "Preview"}
          </Button>
        ) : null}

        {preview ? (
          preview.ok && preview.plan ? (
            <div className="flex flex-col gap-2">
              <div className="flex gap-4 text-xs">
                <span>
                  <Badge tone="positive">NEW</Badge> {preview.plan.newCount}
                </span>
                <span>
                  <Badge tone="neutral">DUPLICATE</Badge>{" "}
                  {preview.plan.duplicateCount}
                </span>
                {preview.plan.issueCount > 0 ? (
                  <span>
                    <Badge tone="negative">ISSUE</Badge>{" "}
                    {preview.plan.issueCount}
                  </span>
                ) : null}
              </div>
              <details className="text-[11px] text-ink-600">
                <summary className="cursor-pointer">
                  Per-rule detail ({preview.plan.entries.length})
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {preview.plan.entries.map((e) => (
                    <li key={e.index} className="flex items-start gap-1.5">
                      <Badge
                        tone={
                          e.issue
                            ? "negative"
                            : e.disposition === "DUPLICATE"
                              ? "neutral"
                              : "positive"
                        }
                      >
                        {e.issue ? "ISSUE" : e.disposition}
                      </Badge>
                      <span className="font-medium">{e.entry.name}</span>
                      <span className="font-mono text-ink-400">
                        /{e.entry.descriptionRegex}/i
                      </span>
                      {e.duplicateOfName ? (
                        <span className="text-ink-400">
                          → matches "{e.duplicateOfName}"
                        </span>
                      ) : null}
                      {e.issue ? (
                        <span className="text-rose-700">— {e.issue}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
              {preview.plan.newCount > 0 ? (
                <Button size="sm" onClick={onCommit} disabled={pending}>
                  {pending
                    ? "Committing…"
                    : `Commit ${preview.plan.newCount} new rule(s)`}
                </Button>
              ) : (
                <span className="text-[11px] text-ink-500">
                  Nothing to commit — every incoming rule is a duplicate
                  or has an issue.
                </span>
              )}
            </div>
          ) : (
            <div className="rounded-md bg-rose-50 p-2 text-[11px] text-rose-800">
              {preview.message}
            </div>
          )
        ) : null}

        {commitResult ? (
          <div
            className={`rounded-md p-2 text-[11px] ${
              commitResult.ok
                ? "bg-emerald-50 text-emerald-800"
                : "bg-rose-50 text-rose-800"
            }`}
          >
            {commitResult.message}
          </div>
        ) : null}
      </div>
    </div>
  );
}
