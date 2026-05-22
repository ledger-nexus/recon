// CSV parser unit tests. No DB needed — pure transformation.

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBankCsv, CsvParseError } from "../src/lib/csv/parser";

const SAMPLE = readFileSync(
  join(__dirname, "..", "prisma", "fixtures", "acme-bank-march-2026.csv"),
  "utf-8"
);

describe("parseBankCsv: Acme bank fixture", () => {
  it("extracts metadata (period, balances, account label)", () => {
    const r = parseBankCsv(SAMPLE);
    expect(r.meta.periodStart.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(r.meta.periodEnd.toISOString().slice(0, 10)).toBe("2026-03-31");
    expect(r.meta.openingBalance.toNumber()).toBe(459_239.5);
    expect(r.meta.closingBalance.toNumber()).toBe(414_819.5);
    expect(r.meta.bankAccountLabel).toContain("NORTHWIND");
  });

  it("parses 9 transaction lines with correct signs", () => {
    const r = parseBankCsv(SAMPLE);
    expect(r.lines).toHaveLength(9);
    // First line: Globex deposit of $60,000 (positive).
    expect(r.lines[0].amount.toNumber()).toBe(60_000);
    expect(r.lines[0].description).toContain("GLOBEX");
    // Payroll outflow at the end (negative).
    const payroll = r.lines.find((l) => l.description.includes("PAYROLL"));
    expect(payroll).toBeDefined();
    expect(payroll!.amount.toNumber()).toBe(-94_400);
  });

  it("Σ lines reconciles to closing − opening within $0.01", () => {
    const r = parseBankCsv(SAMPLE);
    const sum = r.lines.reduce((acc, l) => acc.plus(l.amount), new Decimal(0));
    const expected = r.meta.closingBalance.minus(r.meta.openingBalance);
    expect(sum.minus(expected).abs().lessThan(new Decimal("0.01"))).toBe(true);
  });

  it("populates lineNo sequentially starting at 1", () => {
    const r = parseBankCsv(SAMPLE);
    expect(r.lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("parseBankCsv: failure modes", () => {
  it("rejects a CSV missing the Date header", () => {
    const bad = `
"Period: 2026-03-01 to 2026-03-31"
"Opening Balance: 100"
"Closing Balance: 100"
"Other","Description","Amount"
"2026-03-15","x",10
`.trim();
    expect(() => parseBankCsv(bad)).toThrow(CsvParseError);
  });

  it("rejects a CSV whose sum doesn't reconcile to closing − opening", () => {
    const bad = `
"Period: 2026-03-01 to 2026-03-31"
"Opening Balance: 100"
"Closing Balance: 999"
"Date","Description","Amount"
"2026-03-15","x",10
`.trim();
    expect(() => parseBankCsv(bad)).toThrow(/Sum-of-lines/);
  });

  it("accepts parenthesized negatives", () => {
    const ok = `
"Period: 2026-03-01 to 2026-03-31"
"Opening Balance: 100"
"Closing Balance: 90"
"Date","Description","Amount"
"2026-03-15","fee",(10.00)
`.trim();
    const r = parseBankCsv(ok);
    expect(r.lines[0].amount.toNumber()).toBe(-10);
  });
});
