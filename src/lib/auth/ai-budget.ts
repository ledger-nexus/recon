// AI budget enforcement: tenant-level rate limit + monthly spend cap.
// Mirror of fa-amort + revenue-rec. recon uses Haiku 4.5 for match
// suggestions (cheap per call) so the monthly cap is less likely to
// trip than in revenue-rec — but the rate limit on proposeAll matters
// since one statement can fire dozens of sequential AI calls.
//
// See fa-amort/src/lib/auth/ai-budget.ts for the full design rationale.

import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";

const TENANT_HOURLY_LIMIT = numFromEnv("AI_TENANT_HOURLY_LIMIT", 600);
const USER_MINUTE_LIMIT = numFromEnv("AI_USER_MINUTE_LIMIT", 60);
const DEFAULT_MONTHLY_CAP_USD = numFromEnv("AI_TENANT_MONTHLY_CAP_USD", 50);

function numFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Anthropic pricing $/M tokens, cached 2026-04-29. recon defaults to
// Haiku 4.5 per its CLAUDE.md ("matching is a structured-output task,
// not deep reasoning").
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7":   { input: 5,   output: 25 },
  "claude-opus-4-6":   { input: 5,   output: 25 },
  "claude-sonnet-4-6": { input: 3,   output: 15 },
  "claude-haiku-4-5":  { input: 1,   output: 5  },
};

export class RateLimitExceededError extends Error {
  constructor(public readonly scope: "tenant" | "user", public readonly limit: number, public readonly windowSeconds: number) {
    super(
      scope === "tenant"
        ? `Tenant rate limit: ${limit} AI calls per hour. Try again in a few minutes.`
        : `User rate limit: ${limit} AI calls per minute. Slow down.`
    );
    this.name = "RateLimitExceededError";
  }
}

export class MonthlySpendCapExceededError extends Error {
  constructor(public readonly spentUsd: Decimal, public readonly capUsd: Decimal) {
    super(
      `Monthly Anthropic spend cap exceeded: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} used this calendar month. ` +
        `Wait for the next month or ask an admin to raise tenant.monthlyAiSpendCapUsd.`
    );
    this.name = "MonthlySpendCapExceededError";
  }
}

export interface EnforceAiBudgetArgs {
  tenantId: string;
  userId: string;
  action: string;
}

export async function enforceAiBudget(args: EnforceAiBudgetArgs): Promise<void> {
  await checkMonthlySpendCap(args.tenantId);
  await checkRateLimits(args.tenantId, args.userId);
  await prisma.rateLimitEvent.create({
    data: { tenantId: args.tenantId, userId: args.userId, action: args.action },
  });
}

async function checkRateLimits(tenantId: string, userId: string): Promise<void> {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);

  const [tenantHourly, userMinute] = await Promise.all([
    prisma.rateLimitEvent.count({ where: { tenantId, createdAt: { gte: oneHourAgo } } }),
    prisma.rateLimitEvent.count({ where: { tenantId, userId, createdAt: { gte: oneMinuteAgo } } }),
  ]);

  if (tenantHourly >= TENANT_HOURLY_LIMIT) {
    throw new RateLimitExceededError("tenant", TENANT_HOURLY_LIMIT, 3600);
  }
  if (userMinute >= USER_MINUTE_LIMIT) {
    throw new RateLimitExceededError("user", USER_MINUTE_LIMIT, 60);
  }
}

async function checkMonthlySpendCap(tenantId: string): Promise<void> {
  const { spentUsd, capUsd } = await computeMonthlySpend(tenantId);
  if (spentUsd.greaterThanOrEqualTo(capUsd)) {
    throw new MonthlySpendCapExceededError(spentUsd, capUsd);
  }
}

async function computeMonthlySpend(tenantId: string): Promise<{
  spentUsd: Decimal;
  capUsd: Decimal;
}> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { monthlyAiSpendCapUsd: true },
  });
  const capUsd = tenant?.monthlyAiSpendCapUsd
    ? new Decimal(tenant.monthlyAiSpendCapUsd.toString())
    : new Decimal(DEFAULT_MONTHLY_CAP_USD);

  const monthStart = startOfCurrentMonthUtc();
  const rows = await prisma.aiSuggestion.findMany({
    where: { tenantId, createdAt: { gte: monthStart } },
    select: { modelName: true, promptTokens: true, completionTokens: true },
  });

  let spentUsd = new Decimal(0);
  for (const r of rows) {
    const price = PRICING[r.modelName];
    if (!price) continue;
    const inputCost = new Decimal(r.promptTokens ?? 0).mul(price.input).div(1_000_000);
    const outputCost = new Decimal(r.completionTokens ?? 0).mul(price.output).div(1_000_000);
    spentUsd = spentUsd.plus(inputCost).plus(outputCost);
  }

  return { spentUsd, capUsd };
}

function startOfCurrentMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

function currentMonthKey(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

// ─── Spend-threshold alerts ──────────────────────────────────────────────
// Mirror of fa-amort/src/lib/auth/ai-budget.ts. See that file for the
// full design rationale.

const THRESHOLDS = [80, 100] as const;
const REPO_NAME = "recon";

export async function emitSpendAlertIfThresholdCrossed(
  tenantId: string
): Promise<void> {
  try {
    const { spentUsd, capUsd } = await computeMonthlySpend(tenantId);
    if (capUsd.lessThanOrEqualTo(0)) return;
    const pctOfCap = spentUsd.div(capUsd).mul(100);
    const monthKey = currentMonthKey();

    for (const threshold of THRESHOLDS) {
      if (pctOfCap.lessThan(threshold)) continue;
      try {
        await prisma.aiSpendAlert.create({
          data: {
            tenantId,
            monthKey,
            threshold,
            capUsd: capUsd.toFixed(2),
            spentUsd: spentUsd.toFixed(2),
          },
        });
      } catch (e) {
        if (isUniqueViolation(e)) continue;
        throw e;
      }
      const message = formatAlertMessage({
        tenantId,
        monthKey,
        threshold,
        capUsd,
        spentUsd,
      });
      console.warn(`[ai-spend-alert] ${message}`);
      await postWebhookBestEffort(message, {
        tenantId,
        monthKey,
        threshold,
        capUsd: capUsd.toFixed(2),
        spentUsd: spentUsd.toFixed(2),
        source: REPO_NAME,
      });
    }
  } catch (e) {
    console.error("[ai-spend-alert] failed to evaluate thresholds", e);
  }
}

function formatAlertMessage(args: {
  tenantId: string;
  monthKey: string;
  threshold: number;
  capUsd: Decimal;
  spentUsd: Decimal;
}): string {
  const verb = args.threshold >= 100 ? "REACHED" : "approaching";
  return (
    `[${REPO_NAME}] Tenant ${args.tenantId} ${verb} ${args.threshold}% ` +
    `of the Anthropic spend cap for ${args.monthKey} — ` +
    `$${args.spentUsd.toFixed(2)} of $${args.capUsd.toFixed(2)}.`
  );
}

async function postWebhookBestEffort(
  text: string,
  payload: Record<string, unknown>
): Promise<void> {
  const url = process.env.AI_ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...payload }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.error(
        `[ai-spend-alert] webhook returned ${res.status}: ${await res
          .text()
          .catch(() => "<unreadable>")}`
      );
    }
  } catch (e) {
    console.error("[ai-spend-alert] webhook POST failed", e);
  }
}

function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const code = (e as { code?: string }).code;
  return code === "P2002";
}
