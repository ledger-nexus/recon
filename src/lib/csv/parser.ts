// Bank-statement CSV parser. Handles the "Acme Bank Generic CSV" format
// — header lines for metadata (Account, Period, Opening/Closing balance)
// followed by a column-headed table of transactions. Real bank formats
// (Chase, BofA, Wells, Mercury, Ramp, etc.) vary in column names and
// date formats; this parser is the minimum that exercises the parser
// API. Production would have one parser per source format with a small
// router.
//
// Output is normalized to ParsedStatement which the orchestrator can
// then persist via Prisma. The parser is deliberately pure (no DB) so
// it can be unit-tested with a string fixture.

import { Decimal } from "decimal.js";

export interface ParsedStatementMeta {
  bankAccountLabel?: string;
  periodStart: Date;
  periodEnd: Date;
  openingBalance: Decimal;
  closingBalance: Decimal;
}

export interface ParsedStatementLine {
  lineNo: number;
  transactionDate: Date;
  description: string;
  amount: Decimal;        // signed: positive = deposit, negative = withdrawal
  runningBalance: Decimal | null;
}

export interface ParsedStatement {
  meta: ParsedStatementMeta;
  lines: ParsedStatementLine[];
}

export class CsvParseError extends Error {
  constructor(public lineNumber: number, message: string) {
    super(`CSV parse error at line ${lineNumber}: ${message}`);
    this.name = "CsvParseError";
  }
}

// Split a CSV row honoring double-quote escaping. Returns an array of
// cells. Pretty minimal — doesn't handle multi-line quoted strings,
// which bank exports rarely contain.
function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 2;
      } else if (ch === '"') {
        inQuotes = false;
        i += 1;
      } else {
        cur += ch;
        i += 1;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i += 1;
      } else if (ch === ",") {
        out.push(cur);
        cur = "";
        i += 1;
      } else {
        cur += ch;
        i += 1;
      }
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function parseDate(s: string): Date {
  // Accept ISO (YYYY-MM-DD) or US (MM/DD/YYYY). Bank exports vary; this
  // covers ~95% of formats seen.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  }
  const us = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (us) {
    return new Date(Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2])));
  }
  throw new Error(`Unrecognized date format: ${s}`);
}

function parseAmount(s: string): Decimal {
  // Strip currency symbols / commas / parens. Parens = negative.
  const trimmed = s.trim();
  if (!trimmed) return new Decimal(0);
  const isParenNeg = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed
    .replace(/[\$£€]/g, "")
    .replace(/,/g, "")
    .replace(/[()]/g, "");
  const value = new Decimal(cleaned);
  return isParenNeg ? value.negated() : value;
}

// Find the header row — the one starting with "Date" or "Posted Date" or
// "Transaction Date". Anything before that is metadata.
function findHeaderRowIndex(rows: string[][]): number {
  for (let i = 0; i < rows.length; i++) {
    const first = (rows[i][0] ?? "").toLowerCase();
    if (first === "date" || first === "posted date" || first === "transaction date") {
      return i;
    }
  }
  throw new CsvParseError(0, "No header row found (expected first cell 'Date' / 'Posted Date' / 'Transaction Date')");
}

// Pull "Opening Balance: 1234.56" / "Period: 2026-03-01 to 2026-03-31"
// kind of metadata out of the lines before the header row.
function extractMeta(headerRows: string[][], defaultPeriodStart: Date, defaultPeriodEnd: Date): ParsedStatementMeta {
  const meta: ParsedStatementMeta = {
    periodStart: defaultPeriodStart,
    periodEnd: defaultPeriodEnd,
    openingBalance: new Decimal(0),
    closingBalance: new Decimal(0),
  };

  for (const row of headerRows) {
    const cell = (row[0] ?? "").trim();
    if (!cell) continue;
    const openMatch = /opening balance[:\s]*([0-9.,$()-]+)/i.exec(cell);
    const closeMatch = /closing balance[:\s]*([0-9.,$()-]+)/i.exec(cell);
    const periodMatch = /period[:\s]+(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})\s+to\s+(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})/i.exec(cell);
    const accountMatch = /account[:\s]+(.+)/i.exec(cell);

    if (openMatch) meta.openingBalance = parseAmount(openMatch[1]);
    if (closeMatch) meta.closingBalance = parseAmount(closeMatch[1]);
    if (periodMatch) {
      meta.periodStart = parseDate(periodMatch[1]);
      meta.periodEnd = parseDate(periodMatch[2]);
    }
    if (accountMatch) meta.bankAccountLabel = accountMatch[1].trim();
  }
  return meta;
}

export function parseBankCsv(csv: string): ParsedStatement {
  const rawLines = csv.split(/\r?\n/).filter((l) => l.length > 0);
  const rows = rawLines.map(parseCsvRow);

  const headerIdx = findHeaderRowIndex(rows);
  const meta = extractMeta(rows.slice(0, headerIdx), new Date(0), new Date(0));
  const headerRow = rows[headerIdx];

  // Find column positions case-insensitively.
  const colIndex = (...names: string[]): number =>
    headerRow.findIndex((h) => names.some((n) => h.toLowerCase() === n.toLowerCase()));
  const dateCol = colIndex("date", "posted date", "transaction date");
  const descCol = colIndex("description", "memo", "details", "payee");
  const amountCol = colIndex("amount", "transaction amount");
  const balanceCol = colIndex("running balance", "balance");

  if (dateCol === -1) throw new CsvParseError(headerIdx + 1, "Missing date column");
  if (descCol === -1) throw new CsvParseError(headerIdx + 1, "Missing description column");
  if (amountCol === -1) throw new CsvParseError(headerIdx + 1, "Missing amount column");

  const lines: ParsedStatementLine[] = [];
  let lineNo = 1;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.every((c) => !c.trim())) continue; // skip empty trailers
    try {
      lines.push({
        lineNo,
        transactionDate: parseDate(row[dateCol]),
        description: row[descCol],
        amount: parseAmount(row[amountCol]),
        runningBalance: balanceCol >= 0 && row[balanceCol] ? parseAmount(row[balanceCol]) : null,
      });
      lineNo += 1;
    } catch (e) {
      throw new CsvParseError(i + 1, e instanceof Error ? e.message : String(e));
    }
  }

  // Sanity check: sum of amounts should equal closingBalance - openingBalance
  // (within a cent). Fail loud — silent parser drift is the worst kind.
  const summed = lines.reduce((acc, l) => acc.plus(l.amount), new Decimal(0));
  const expected = meta.closingBalance.minus(meta.openingBalance);
  if (summed.minus(expected).abs().greaterThan(new Decimal("0.01"))) {
    throw new CsvParseError(
      0,
      `Sum-of-lines (${summed.toFixed(2)}) ≠ closing − opening (${expected.toFixed(2)}). ` +
        `Either the CSV is corrupt or the parser missed columns.`
    );
  }

  return { meta, lines };
}
