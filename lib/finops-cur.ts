/**
 * AWS CUR 2.0 / FOCUS 1.0 CSV line-item ingestion: a pure, deterministic
 * parser + normalizer. Money is handled honestly:
 * - Malformed rows are REJECTED AND DISCLOSED (row number + reason), never
 *   silently dropped and never "repaired" by guessing.
 * - Every accepted line keeps its source line-item identity so totals remain
 *   traceable back to the billing file.
 * - Amounts are parsed as decimal strings into micro-units (integer bigint
 *   math) to avoid float drift; the currency is carried, never assumed.
 * - No savings, forecasting, or reconciliation claims live here — this is
 *   ingestion and shaping only.
 */

export type CurDialect = "cur-2.0" | "focus-1.0";

export interface NormalizedCurLine {
  readonly lineItemId: string;
  readonly usageAccountId: string;
  readonly service: string;
  readonly chargeCategory: string;
  readonly usageStartIso: string;
  readonly amountMicros: string; // integer micro-units as a decimal string (bigint-safe)
  readonly currency: string;
  readonly region: string | null; // cloud region of the line item; null when the billing file omits it
  readonly tags: Readonly<Record<string, string>>;
}

export interface RejectedCurRow {
  readonly rowNumber: number;
  readonly reason: string;
}

export interface CurParseResult {
  readonly dialect: CurDialect;
  readonly lines: readonly NormalizedCurLine[];
  readonly rejected: readonly RejectedCurRow[];
  readonly totalRows: number;
  readonly currencies: readonly string[];
  readonly disclaimer: string;
}

export const CUR_PARSE_DISCLAIMER =
  "Ingested billing lines are shaped, not reconciled: totals are sums of accepted line items in " +
  "their original currency. Rejected rows are listed and excluded — they are never estimated. " +
  "This is not an invoice reconciliation and makes no savings claim.";

export const CUR_MAX_ROWS = 100_000;

/** Minimal CSV parser: quoted fields, escaped quotes, CRLF/LF. Deterministic, no regex backtracking. */
export function parseCsv(text: string, maxRows = CUR_MAX_ROWS + 1): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ",") { row.push(field); field = ""; continue; }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
      continue;
    }
    field += char;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

/** Parse a decimal money string into micro-units without float math. */
export function toMicros(value: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,12}))?$/u.exec(value.trim());
  if (match === null) return null;
  const sign = match[1] === "-" ? BigInt(-1) : BigInt(1);
  const whole = BigInt(match[2]);
  const fraction = (match[3] ?? "").padEnd(6, "0").slice(0, 6);
  return (sign * (whole * BigInt(1000000) + BigInt(fraction || "0"))).toString();
}

interface ColumnMap {
  readonly dialect: CurDialect;
  readonly lineItemId: number;
  readonly account: number;
  readonly service: number;
  readonly chargeCategory: number;
  readonly usageStart: number;
  readonly amount: number;
  readonly currency: number;
  readonly region: number; // -1 when the billing file has no region column
  readonly tagColumns: readonly { readonly index: number; readonly key: string }[];
}

function detectColumns(header: readonly string[]): ColumnMap | null {
  const lookup = new Map(header.map((name, index) => [name.trim(), index]));
  // Optional region column; -1 (absent) when none of the known aliases are present.
  const firstIndex = (...names: readonly string[]): number => {
    for (const name of names) {
      const index = lookup.get(name);
      if (index !== undefined) return index;
    }
    return -1;
  };
  const focus = ["BillingAccountId", "ServiceName", "ChargeCategory", "ChargePeriodStart", "BilledCost", "BillingCurrency"];
  if (focus.every((column) => lookup.has(column))) {
    return {
      dialect: "focus-1.0",
      lineItemId: lookup.get("ChargeDescription") ?? lookup.get("ResourceId") ?? -1,
      account: lookup.get("SubAccountId") ?? (lookup.get("BillingAccountId") as number),
      service: lookup.get("ServiceName") as number,
      chargeCategory: lookup.get("ChargeCategory") as number,
      usageStart: lookup.get("ChargePeriodStart") as number,
      amount: lookup.get("BilledCost") as number,
      currency: lookup.get("BillingCurrency") as number,
      region: firstIndex("RegionId", "RegionName"),
      tagColumns: header.flatMap((name, index) => (name.startsWith("Tags/") ? [{ index, key: name.slice(5) }] : [])),
    };
  }
  const cur = ["line_item_id", "line_item_usage_account_id", "product_servicecode", "line_item_line_item_type", "line_item_usage_start_date", "line_item_unblended_cost", "line_item_currency_code"];
  if (cur.every((column) => lookup.has(column))) {
    return {
      dialect: "cur-2.0",
      lineItemId: lookup.get("line_item_id") as number,
      account: lookup.get("line_item_usage_account_id") as number,
      service: lookup.get("product_servicecode") as number,
      chargeCategory: lookup.get("line_item_line_item_type") as number,
      usageStart: lookup.get("line_item_usage_start_date") as number,
      amount: lookup.get("line_item_unblended_cost") as number,
      currency: lookup.get("line_item_currency_code") as number,
      region: firstIndex("product_region_code", "product region", "region"),
      tagColumns: header.flatMap((name, index) =>
        name.startsWith("resource_tags_user_") ? [{ index, key: name.slice("resource_tags_user_".length) }] : []),
    };
  }
  return null;
}

/** Parse a CUR 2.0 or FOCUS 1.0 CSV export. Never throws on data rows — rejects and discloses. */
export function parseCurCsv(text: string): CurParseResult | { readonly error: string } {
  const rows = parseCsv(text);
  if (rows.length === 0) return { error: "The file is empty" };
  if (rows.length - 1 > CUR_MAX_ROWS) return { error: `The file exceeds the maximum of ${CUR_MAX_ROWS} data rows` };
  const columns = detectColumns(rows[0]);
  if (columns === null) {
    return { error: "The header is neither AWS CUR 2.0 (line_item_*) nor FOCUS 1.0 (BilledCost/ChargeCategory) format" };
  }
  const lines: NormalizedCurLine[] = [];
  const rejected: RejectedCurRow[] = [];
  const currencies = new Set<string>();
  for (let rowNumber = 1; rowNumber < rows.length; rowNumber += 1) {
    const row = rows[rowNumber];
    const cell = (index: number): string => (index >= 0 && index < row.length ? row[index].trim() : "");
    const amountRaw = cell(columns.amount);
    const amountMicros = toMicros(amountRaw);
    if (amountMicros === null) {
      rejected.push({ rowNumber, reason: `amount '${amountRaw.slice(0, 32)}' is not a decimal number` });
      continue;
    }
    const currency = cell(columns.currency).toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currency)) {
      rejected.push({ rowNumber, reason: "currency is missing or not a 3-letter code" });
      continue;
    }
    const usageStart = cell(columns.usageStart);
    const usageStartMs = Date.parse(usageStart);
    if (!Number.isFinite(usageStartMs)) {
      rejected.push({ rowNumber, reason: "usage start date is not parseable" });
      continue;
    }
    const account = cell(columns.account);
    const service = cell(columns.service);
    if (account.length === 0 || service.length === 0) {
      rejected.push({ rowNumber, reason: "account id or service is empty" });
      continue;
    }
    const tags: Record<string, string> = {};
    for (const tag of columns.tagColumns) {
      const value = cell(tag.index);
      if (value.length > 0) tags[tag.key] = value;
    }
    const providedId = cell(columns.lineItemId);
    const region = cell(columns.region);
    lines.push({
      lineItemId: providedId.length > 0 ? providedId : `row-${rowNumber}`,
      usageAccountId: account,
      service,
      chargeCategory: cell(columns.chargeCategory) || "Unspecified",
      usageStartIso: new Date(usageStartMs).toISOString(),
      amountMicros,
      currency,
      region: region.length > 0 ? region : null,
      tags,
    });
    currencies.add(currency);
  }
  return {
    dialect: columns.dialect,
    lines,
    rejected,
    totalRows: rows.length - 1,
    currencies: [...currencies].sort(),
    disclaimer: CUR_PARSE_DISCLAIMER,
  };
}
