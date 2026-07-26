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
  // Amortized/effective cost of the line as integer micro-units (bigint-safe
  // decimal string, mirroring amountMicros); null when the billing file carries
  // no amortized/effective column. amountMicros stays the billed/unblended cost.
  readonly amortizedMicros: string | null;
  // Commitment discount classification: FOCUS CommitmentDiscountType verbatim
  // (e.g. "Reserved", "SavingsPlan"); for CUR 2.0 an inferred lowercase token
  // ("reserved", "savings_plan", "spot", "on_demand"). null when not derivable.
  readonly commitmentType: string | null;
  readonly commitmentId: string | null; // FOCUS CommitmentDiscountId / CUR reservation or SP ARN; null when absent
  readonly commitmentExpiry: string | null; // ISO expiry (FOCUS CommitmentDiscountExpirationDate / CUR end-time) when present
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

/**
 * Amortized/effective cost for a row as bigint-safe micro-units, or null when
 * the file carries no amortized column. A single net-amortized/EffectiveCost
 * column wins; otherwise the CUR reservation + savings-plan effective-cost
 * parts are summed (both present is rare but summing is correct either way).
 * A blank or non-numeric cell contributes nothing — nothing is fabricated.
 */
function amortizedMicrosFor(columns: ColumnMap, cell: (index: number) => string): string | null {
  if (columns.amortized >= 0) {
    const raw = cell(columns.amortized);
    return raw.length === 0 ? null : toMicros(raw);
  }
  let sum = BigInt(0);
  let any = false;
  for (const index of [columns.amortizedReservation, columns.amortizedSavingsPlan]) {
    if (index < 0) continue;
    const raw = cell(index);
    if (raw.length === 0) continue;
    const micros = toMicros(raw);
    if (micros === null) continue;
    sum += BigInt(micros);
    any = true;
  }
  return any ? sum.toString() : null;
}

/**
 * Commitment classification. FOCUS uses CommitmentDiscountType verbatim; CUR
 * 2.0 has no such column, so it is inferred (only for the CUR dialect) from the
 * presence of a reservation/SP ARN, the pricing term, or the line-item type.
 * Ambiguous lines (credits, taxes, fees) stay null rather than being guessed.
 */
function commitmentTypeFor(columns: ColumnMap, cell: (index: number) => string): string | null {
  if (columns.commitmentType >= 0) {
    const value = cell(columns.commitmentType);
    return value.length > 0 ? value : null;
  }
  if (columns.dialect !== "cur-2.0") return null;
  const term = columns.pricingTerm >= 0 ? cell(columns.pricingTerm).toLowerCase() : "";
  const lineItemType = cell(columns.chargeCategory).toLowerCase();
  const reservation = columns.reservationArn >= 0 ? cell(columns.reservationArn) : "";
  const savingsPlan = columns.savingsPlanArn >= 0 ? cell(columns.savingsPlanArn) : "";
  if (savingsPlan.length > 0 || term === "savingsplan" || lineItemType.startsWith("savingsplan")) return "savings_plan";
  if (reservation.length > 0 || term === "reserved" || lineItemType === "discountedusage" || lineItemType === "rifee") return "reserved";
  if (term === "spot" || lineItemType === "spotusage") return "spot";
  if (term === "ondemand" || lineItemType === "usage") return "on_demand";
  return null;
}

/** Commitment identifier: FOCUS id, else the first non-empty CUR ARN. */
function commitmentIdFor(columns: ColumnMap, cell: (index: number) => string): string | null {
  if (columns.commitmentId >= 0) {
    const value = cell(columns.commitmentId);
    if (value.length > 0) return value;
  }
  for (const index of [columns.reservationArn, columns.savingsPlanArn]) {
    if (index < 0) continue;
    const value = cell(index);
    if (value.length > 0) return value;
  }
  return null;
}

/** Commitment expiry normalized to ISO when parseable; raw string otherwise; null when absent. */
function commitmentExpiryFor(columns: ColumnMap, cell: (index: number) => string): string | null {
  if (columns.commitmentExpiry < 0) return null;
  const raw = cell(columns.commitmentExpiry);
  if (raw.length === 0) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : raw;
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
  // Amortized/effective cost sources (each -1 when absent). `amortized` is a
  // single net-amortized/EffectiveCost column; when it is absent the CUR parts
  // (reservation + savings-plan effective cost) are summed instead.
  readonly amortized: number;
  readonly amortizedReservation: number;
  readonly amortizedSavingsPlan: number;
  // Commitment discount attribution sources (each -1 when absent).
  readonly commitmentType: number; // FOCUS CommitmentDiscountType (CUR infers instead)
  readonly pricingTerm: number; // CUR pricing_term, used only for CUR inference
  readonly commitmentId: number; // FOCUS CommitmentDiscountId (CUR coalesces the ARNs)
  readonly reservationArn: number; // CUR reservation ARN
  readonly savingsPlanArn: number; // CUR savings-plan ARN
  readonly commitmentExpiry: number; // FOCUS expiry date / CUR reservation|SP end-time
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
      amortized: firstIndex("EffectiveCost"),
      amortizedReservation: -1,
      amortizedSavingsPlan: -1,
      commitmentType: firstIndex("CommitmentDiscountType"),
      pricingTerm: -1,
      commitmentId: firstIndex("CommitmentDiscountId"),
      reservationArn: -1,
      savingsPlanArn: -1,
      commitmentExpiry: firstIndex("CommitmentDiscountExpirationDate"),
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
      amortized: firstIndex("line_item_net_amortized_cost", "amortized_cost", "line_item_amortized_cost"),
      amortizedReservation: firstIndex("reservation_effective_cost"),
      amortizedSavingsPlan: firstIndex("savings_plan_effective_cost", "savings_plan_savings_plan_effective_cost"),
      commitmentType: -1,
      pricingTerm: firstIndex("pricing_term", "line_item_pricing_term"),
      commitmentId: -1,
      reservationArn: firstIndex("reservation_reservation_a_r_n", "reservation_reservationarn", "reservation_arn"),
      savingsPlanArn: firstIndex("savings_plan_savings_plan_a_r_n", "savings_plan_savings_plan_arn", "savings_plan_arn"),
      commitmentExpiry: firstIndex("reservation_end_time", "savings_plan_end_time"),
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
      amortizedMicros: amortizedMicrosFor(columns, cell),
      commitmentType: commitmentTypeFor(columns, cell),
      commitmentId: commitmentIdFor(columns, cell),
      commitmentExpiry: commitmentExpiryFor(columns, cell),
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
