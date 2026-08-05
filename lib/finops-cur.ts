/**
 * AWS CUR 2.0 / FOCUS 1.0 and 1.2 CSV line-item ingestion: a pure, deterministic
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

export type CurDialect = "cur-2.0" | "focus-1.0" | "focus-1.2";
export type CurSourceFormat = "aws-cur" | "focus";
export type CurSourceVersion = "2.0" | "1.0" | "1.2";
export type CurChargeKind =
  | "usage"
  | "purchase"
  | "tax"
  | "credit"
  | "refund"
  | "discount"
  | "adjustment"
  | "other";

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
  // Usage-type string verbatim from the billing file (CUR line_item_usage_type,
  // FOCUS SkuId/SkuPriceId). This is the ONLY column that names the metered
  // thing — the instance type behind compute spend ("USE1-BoxUsage:p4d.24xlarge")
  // and the model + token direction behind Bedrock spend
  // ("USE1-InputTokenCount-anthropic.claude-3-sonnet"). null when the billing
  // file has no usage-type column; nothing is inferred from its absence.
  readonly usageType: string | null;
  // Metered QUANTITY (not money) as integer micro-units, bigint-safe decimal
  // string, mirroring amountMicros: CUR line_item_usage_amount, FOCUS
  // ConsumedQuantity/PricingQuantity. Token counts and GPU-hours are quantities,
  // never derived from cost. null when the file carries no quantity column.
  readonly usageAmountMicros: string | null;
  // Unit the quantity is expressed in, verbatim (CUR pricing_unit, FOCUS
  // ConsumedUnit/PricingUnit) — e.g. "tokens", "1K tokens", "Hrs". Without it a
  // quantity is NOT rescaled; consumers must disclose the unit as unknown.
  readonly usageUnit: string | null;
  readonly tags: Readonly<Record<string, string>>;
}

/**
 * The complete record guaranteed for lines returned by parseCurCsv.
 *
 * NormalizedCurLine deliberately remains the small, source-compatible base
 * used by the existing analytics functions and their hand-authored fixtures.
 * New ingestion consumers should use CanonicalCurLine (which parseCurCsv
 * returns) so source provenance and invoice/CID dimensions cannot disappear.
 */
export interface CanonicalCurLine extends NormalizedCurLine {
  readonly sourceFormat: CurSourceFormat;
  readonly sourceVersion: CurSourceVersion;

  readonly payerAccountId: string | null;
  readonly payerAccountName: string | null;
  readonly usageAccountName: string | null;
  readonly billingPeriodStartIso: string | null;
  readonly billingPeriodEndIso: string | null;
  readonly usageEndIso: string | null;

  readonly invoiceId: string | null;
  readonly invoiceIssuerId: string | null;
  readonly invoiceIssuerName: string | null;
  readonly billingEntity: string | null;
  readonly legalEntity: string | null;
  readonly billType: string | null;

  readonly resourceId: string | null;
  readonly resourceName: string | null;
  readonly resourceType: string | null;
  readonly availabilityZone: string | null;
  readonly operation: string | null;
  readonly productCode: string | null;
  readonly productName: string | null;
  readonly productFamily: string | null;
  readonly serviceCategory: string | null;
  readonly serviceSubcategory: string | null;
  /** AWS CUR2 product dimensions used by the CID Data Transfer view. */
  readonly providerServiceCode?: string | null;
  readonly providerServiceName?: string | null;
  readonly transferType?: string | null;
  readonly fromLocation?: string | null;
  readonly toLocation?: string | null;
  readonly fromLocationType?: string | null;

  readonly chargeClass: string | null;
  readonly chargeDescription: string | null;
  readonly chargeFrequency: string | null;
  readonly chargeKind: CurChargeKind;
  readonly taxType: string | null;
  // These retain the signed billed amount only when the source identifies the
  // row as that exact charge kind. null means "not this kind", never zero.
  readonly taxMicros: string | null;
  readonly creditMicros: string | null;
  readonly refundMicros: string | null;

  readonly netUnblendedCostMicros: string | null;
  readonly listCostMicros: string | null;
  readonly contractedCostMicros: string | null;
  readonly publicOnDemandCostMicros: string | null;
  readonly listUnitPriceMicros: string | null;
  readonly contractedUnitPriceMicros: string | null;
  readonly publicOnDemandRateMicros: string | null;
  readonly pricingCurrency: string | null;
  readonly pricingCurrencyEffectiveCostMicros: string | null;
  readonly pricingCurrencyListUnitPriceMicros: string | null;
  readonly pricingCurrencyContractedUnitPriceMicros: string | null;
  readonly pricingCategory: string | null;
  readonly pricingTerm: string | null;
  readonly pricingRateId: string | null;

  readonly commitmentName: string | null;
  readonly commitmentCategory: string | null;
  readonly commitmentStatus: string | null;
  readonly commitmentStart: string | null;
  readonly commitmentQuantityMicros: string | null;
  readonly commitmentUnit: string | null;
  readonly commitmentPurchaseOption: string | null;
  readonly capacityReservationId: string | null;
  readonly capacityReservationStatus: string | null;
  readonly costCategories: Readonly<Record<string, string>>;
}

export interface RejectedCurRow {
  readonly rowNumber: number;
  readonly reason: string;
}

export interface CurParseResult {
  readonly dialect: CurDialect;
  readonly sourceFormat: CurSourceFormat;
  readonly sourceVersion: CurSourceVersion;
  readonly lines: readonly CanonicalCurLine[];
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

/**
 * Verbatim text from an optional column, trimmed; null when the column is
 * absent or the cell is blank. Never "" — absence stays distinguishable.
 */
function optionalTextFor(index: number, cell: (index: number) => string, maxLength: number): string | null {
  if (index < 0) return null;
  const value = cell(index);
  return value.length > 0 ? value.slice(0, maxLength) : null;
}

/**
 * Metered quantity as integer micro-units. A blank cell or a non-decimal cell
 * yields null — a quantity is never repaired, defaulted to zero, or back-derived
 * from cost. Unlike the money columns a bad quantity does NOT reject the row:
 * the cost is still trustworthy, only the quantity is unavailable.
 */
function usageAmountMicrosFor(columns: ColumnMap, cell: (index: number) => string): string | null {
  if (columns.usageAmount < 0) return null;
  const raw = cell(columns.usageAmount);
  return raw.length === 0 ? null : toMicros(raw);
}

interface OptionalValueResult<T> {
  readonly value: T;
  readonly error: string | null;
}

function optionalIsoFor(
  index: number,
  cell: (index: number) => string,
  label: string,
): OptionalValueResult<string | null> {
  if (index < 0) return { value: null, error: null };
  const raw = cell(index);
  if (raw.length === 0) return { value: null, error: null };
  const ms = Date.parse(raw);
  return Number.isFinite(ms)
    ? { value: new Date(ms).toISOString(), error: null }
    : { value: null, error: `${label} is not parseable` };
}

function optionalMicrosFor(
  index: number,
  cell: (index: number) => string,
  label: string,
): OptionalValueResult<string | null> {
  if (index < 0) return { value: null, error: null };
  const raw = cell(index);
  if (raw.length === 0) return { value: null, error: null };
  const micros = toMicros(raw);
  return micros === null
    ? { value: null, error: `${label} '${raw.slice(0, 32)}' is not a decimal number` }
    : { value: micros, error: null };
}

/**
 * CSV projections of map columns must encode a JSON object. Expanded columns
 * (Tags/foo, resource_tags_user_foo, cost_category_foo) remain supported.
 * Non-string map values are rejected rather than coerced into misleading tags.
 */
function structuredStringMapFor(
  index: number,
  cell: (index: number) => string,
  label: string,
): OptionalValueResult<Readonly<Record<string, string>>> {
  if (index < 0) return { value: {}, error: null };
  const raw = cell(index);
  if (raw.length === 0) return { value: {}, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { value: {}, error: `${label} is not a JSON object` };
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    return { value: {}, error: `${label} is not a JSON object` };
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      return { value: {}, error: `${label} value for '${key.slice(0, 64)}' is not a string` };
    }
    const normalizedKey = key.trim();
    if (normalizedKey.length > 0 && value.length > 0) normalized[normalizedKey.slice(0, 256)] = value.slice(0, 1024);
  }
  return { value: normalized, error: null };
}

function chargeKindFor(chargeCategory: string, billType: string | null): CurChargeKind {
  const category = chargeCategory.trim().toLowerCase();
  const bill = billType?.trim().toLowerCase() ?? "";
  if (category === "refund" || bill === "refund") return "refund";
  if (category === "tax") return "tax";
  if (category === "credit") return "credit";
  if (
    category === "discount" ||
    category === "bundleddiscount" ||
    category === "edpdiscount" ||
    category === "savingsplannegation"
  ) return "discount";
  if (category === "adjustment") return "adjustment";
  if (
    category === "purchase" ||
    bill === "purchase" ||
    category === "fee" ||
    category === "rifee" ||
    category === "savingsplanupfrontfee" ||
    category === "savingsplanrecurringfee"
  ) return "purchase";
  if (
    category === "usage" ||
    category === "discountedusage" ||
    category === "spotusage" ||
    category === "savingsplancoveredusage"
  ) return "usage";
  return "other";
}

interface ColumnMap {
  readonly dialect: CurDialect;
  readonly sourceFormat: CurSourceFormat;
  readonly sourceVersion: CurSourceVersion;
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
  // Usage-type / metered-quantity sources (each -1 when absent).
  readonly usageType: number;
  readonly usageAmount: number;
  readonly usageUnit: number;
  // Account, period, invoice, and legal dimensions.
  readonly payerAccountId: number;
  readonly payerAccountName: number;
  readonly usageAccountName: number;
  readonly billingPeriodStart: number;
  readonly billingPeriodEnd: number;
  readonly usageEnd: number;
  readonly invoiceId: number;
  readonly invoiceIssuerId: number;
  readonly invoiceIssuerName: number;
  readonly billingEntity: number;
  readonly legalEntity: number;
  readonly billType: number;
  // Resource, operation, and product dimensions.
  readonly resourceId: number;
  readonly resourceName: number;
  readonly resourceType: number;
  readonly availabilityZone: number;
  readonly operation: number;
  readonly productCode: number;
  readonly productName: number;
  readonly productFamily: number;
  readonly serviceCategory: number;
  readonly serviceSubcategory: number;
  readonly providerServiceCode: number;
  readonly providerServiceName: number;
  readonly transferType: number;
  readonly fromLocation: number;
  readonly toLocation: number;
  readonly fromLocationType: number;
  // Charge and pricing dimensions/metrics.
  readonly chargeClass: number;
  readonly chargeDescription: number;
  readonly chargeFrequency: number;
  readonly taxType: number;
  readonly netUnblendedCost: number;
  readonly listCost: number;
  readonly contractedCost: number;
  readonly publicOnDemandCost: number;
  readonly listUnitPrice: number;
  readonly contractedUnitPrice: number;
  readonly publicOnDemandRate: number;
  readonly pricingCurrency: number;
  readonly pricingCurrencyEffectiveCost: number;
  readonly pricingCurrencyListUnitPrice: number;
  readonly pricingCurrencyContractedUnitPrice: number;
  readonly pricingCategory: number;
  readonly pricingRateId: number;
  // Extended commitment/capacity dimensions.
  readonly commitmentName: number;
  readonly commitmentCategory: number;
  readonly commitmentStatus: number;
  readonly commitmentStart: number;
  readonly commitmentQuantity: number;
  readonly commitmentUnit: number;
  readonly commitmentPurchaseOption: number;
  readonly capacityReservationId: number;
  readonly capacityReservationStatus: number;
  readonly structuredTags: number;
  readonly structuredCostCategories: number;
  readonly tagColumns: readonly { readonly index: number; readonly key: string }[];
  readonly costCategoryColumns: readonly { readonly index: number; readonly key: string }[];
}

function detectColumns(header: readonly string[]): ColumnMap | null {
  const lookup = new Map(header.map((name, index) => [name.trim(), index]));
  const firstIndex = (...names: readonly string[]): number => {
    for (const name of names) {
      const index = lookup.get(name);
      if (index !== undefined) return index;
    }
    return -1;
  };
  const focus = ["BillingAccountId", "ServiceName", "ChargeCategory", "ChargePeriodStart", "BilledCost", "BillingCurrency"];
  if (focus.every((column) => lookup.has(column))) {
    // FOCUS CSV rows do not carry their manifest. Columns introduced in 1.2
    // are therefore the only honest in-band discriminator. A projected subset
    // with none of these signals remains 1.0 rather than being guessed as 1.2.
    const focus12Signals = [
      "BillingAccountType",
      "SubAccountType",
      "InvoiceId",
      "InvoiceIssuerId",
      "CapacityReservationId",
      "CapacityReservationStatus",
      "CommitmentDiscountQuantity",
      "CommitmentDiscountUnit",
      "ServiceSubcategory",
      "SkuMeter",
      "SkuPriceDetails",
      "PricingCurrency",
      "PricingCurrencyEffectiveCost",
      "PricingCurrencyListUnitPrice",
      "PricingCurrencyContractedUnitPrice",
    ];
    const sourceVersion: CurSourceVersion = focus12Signals.some((column) => lookup.has(column)) ? "1.2" : "1.0";
    return {
      dialect: sourceVersion === "1.2" ? "focus-1.2" : "focus-1.0",
      sourceFormat: "focus",
      sourceVersion,
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
      // FOCUS 1.0 has no usage-type column; SkuId/SkuPriceId is the nearest
      // metered-SKU identifier. FOCUS 1.2 replaces AWS x_UsageType with
      // SkuMeter, which is preferred when present. ChargeDescription is
      // deliberately not a fallback because it is free text.
      usageType: firstIndex("SkuMeter", "x_UsageType", "SkuId", "SkuPriceId"),
      usageAmount: firstIndex("ConsumedQuantity", "PricingQuantity"),
      usageUnit: firstIndex("ConsumedUnit", "PricingUnit"),
      payerAccountId: lookup.get("BillingAccountId") as number,
      payerAccountName: firstIndex("BillingAccountName"),
      usageAccountName: firstIndex("SubAccountName"),
      billingPeriodStart: firstIndex("BillingPeriodStart"),
      billingPeriodEnd: firstIndex("BillingPeriodEnd"),
      usageEnd: firstIndex("ChargePeriodEnd"),
      invoiceId: firstIndex("InvoiceId"),
      invoiceIssuerId: firstIndex("InvoiceIssuerId"),
      invoiceIssuerName: firstIndex("InvoiceIssuerName"),
      billingEntity: firstIndex("ProviderName"),
      legalEntity: firstIndex("PublisherName"),
      billType: -1,
      resourceId: firstIndex("ResourceId"),
      resourceName: firstIndex("ResourceName"),
      resourceType: firstIndex("ResourceType"),
      availabilityZone: firstIndex("AvailabilityZone"),
      operation: firstIndex("x_Operation"),
      productCode: firstIndex("x_ServiceCode"),
      productName: lookup.get("ServiceName") as number,
      productFamily: -1,
      serviceCategory: firstIndex("ServiceCategory"),
      serviceSubcategory: firstIndex("ServiceSubcategory"),
      providerServiceCode: -1,
      providerServiceName: -1,
      transferType: -1,
      fromLocation: -1,
      toLocation: -1,
      fromLocationType: -1,
      chargeClass: firstIndex("ChargeClass"),
      chargeDescription: firstIndex("ChargeDescription"),
      chargeFrequency: firstIndex("ChargeFrequency"),
      taxType: -1,
      netUnblendedCost: -1,
      listCost: firstIndex("ListCost"),
      contractedCost: firstIndex("ContractedCost"),
      publicOnDemandCost: -1,
      listUnitPrice: firstIndex("ListUnitPrice"),
      contractedUnitPrice: firstIndex("ContractedUnitPrice"),
      publicOnDemandRate: -1,
      pricingCurrency: firstIndex("PricingCurrency"),
      pricingCurrencyEffectiveCost: firstIndex("PricingCurrencyEffectiveCost"),
      pricingCurrencyListUnitPrice: firstIndex("PricingCurrencyListUnitPrice"),
      pricingCurrencyContractedUnitPrice: firstIndex("PricingCurrencyContractedUnitPrice"),
      pricingCategory: firstIndex("PricingCategory"),
      pricingRateId: firstIndex("SkuPriceId"),
      commitmentName: firstIndex("CommitmentDiscountName"),
      commitmentCategory: firstIndex("CommitmentDiscountCategory"),
      commitmentStatus: firstIndex("CommitmentDiscountStatus"),
      commitmentStart: firstIndex("CommitmentDiscountStartDate"),
      commitmentQuantity: firstIndex("CommitmentDiscountQuantity"),
      commitmentUnit: firstIndex("CommitmentDiscountUnit"),
      commitmentPurchaseOption: -1,
      capacityReservationId: firstIndex("CapacityReservationId"),
      capacityReservationStatus: firstIndex("CapacityReservationStatus"),
      structuredTags: firstIndex("Tags"),
      structuredCostCategories: firstIndex("x_CostCategories"),
      tagColumns: header.flatMap((name, index) => (name.startsWith("Tags/") ? [{ index, key: name.slice(5) }] : [])),
      costCategoryColumns: [],
    };
  }
  const cur = ["line_item_id", "line_item_usage_account_id", "product_servicecode", "line_item_line_item_type", "line_item_usage_start_date", "line_item_unblended_cost", "line_item_currency_code"];
  if (cur.every((column) => lookup.has(column))) {
    return {
      dialect: "cur-2.0",
      sourceFormat: "aws-cur",
      sourceVersion: "2.0",
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
      usageType: firstIndex("line_item_usage_type", "usage_type"),
      usageAmount: firstIndex("line_item_usage_amount", "usage_amount"),
      usageUnit: firstIndex("pricing_unit", "line_item_usage_unit", "product_usagetype_unit"),
      payerAccountId: firstIndex("bill_payer_account_id"),
      payerAccountName: firstIndex("bill_payer_account_name"),
      usageAccountName: firstIndex("line_item_usage_account_name"),
      billingPeriodStart: firstIndex("bill_billing_period_start_date"),
      billingPeriodEnd: firstIndex("bill_billing_period_end_date"),
      usageEnd: firstIndex("line_item_usage_end_date"),
      invoiceId: firstIndex("bill_invoice_id"),
      invoiceIssuerId: -1,
      invoiceIssuerName: firstIndex("bill_invoicing_entity"),
      billingEntity: firstIndex("bill_billing_entity"),
      legalEntity: firstIndex("line_item_legal_entity"),
      billType: firstIndex("bill_bill_type"),
      resourceId: firstIndex("line_item_resource_id"),
      resourceName: firstIndex("resource_name", "product_resource_name"),
      resourceType: firstIndex("resource_type", "product_resource_type"),
      availabilityZone: firstIndex("line_item_availability_zone"),
      operation: firstIndex("line_item_operation"),
      productCode: firstIndex("line_item_product_code", "product_servicecode"),
      productName: firstIndex("product_product_name", "product_productname", "product_name"),
      productFamily: firstIndex("product_product_family", "product_productfamily", "product_family"),
      serviceCategory: firstIndex("product_service_category", "service_category"),
      serviceSubcategory: firstIndex("product_service_subcategory", "service_subcategory"),
      providerServiceCode: firstIndex("product_servicecode"),
      providerServiceName: firstIndex("product_servicename", "product_service_name"),
      transferType: firstIndex("product_transfer_type", "product_transfertype", "transfer_type"),
      fromLocation: firstIndex("product_from_location", "from_location"),
      toLocation: firstIndex("product_to_location", "to_location"),
      fromLocationType: firstIndex("product_from_location_type", "from_location_type"),
      chargeClass: -1,
      chargeDescription: firstIndex("line_item_line_item_description"),
      chargeFrequency: -1,
      taxType: firstIndex("line_item_tax_type"),
      netUnblendedCost: firstIndex("line_item_net_unblended_cost"),
      listCost: -1,
      contractedCost: -1,
      publicOnDemandCost: firstIndex("pricing_public_on_demand_cost"),
      listUnitPrice: -1,
      contractedUnitPrice: -1,
      publicOnDemandRate: firstIndex("pricing_public_on_demand_rate"),
      pricingCurrency: firstIndex("pricing_currency"),
      pricingCurrencyEffectiveCost: -1,
      pricingCurrencyListUnitPrice: -1,
      pricingCurrencyContractedUnitPrice: -1,
      pricingCategory: -1,
      pricingRateId: firstIndex("pricing_rate_id", "pricing_rate_code"),
      commitmentName: -1,
      commitmentCategory: firstIndex("savings_plan_offering_type"),
      commitmentStatus: -1,
      commitmentStart: firstIndex("reservation_start_time", "savings_plan_start_time"),
      commitmentQuantity: firstIndex("reservation_total_reserved_units"),
      commitmentUnit: firstIndex("reservation_unit"),
      commitmentPurchaseOption: firstIndex("pricing_purchase_option", "savings_plan_payment_option"),
      capacityReservationId: firstIndex(
        "capacity_reservation_capacity_reservation_arn",
        "capacity_reservation_id",
      ),
      capacityReservationStatus: firstIndex(
        "capacity_reservation_capacity_reservation_status",
        "capacity_reservation_status",
      ),
      structuredTags: firstIndex("resource_tags", "tags"),
      structuredCostCategories: firstIndex("cost_category", "cost_categories"),
      tagColumns: header.flatMap((name, index) =>
        name.startsWith("resource_tags_user_") ? [{ index, key: name.slice("resource_tags_user_".length) }] : []),
      costCategoryColumns: header.flatMap((name, index) =>
        name.startsWith("cost_category_") ? [{ index, key: name.slice("cost_category_".length) }] : []),
    };
  }
  return null;
}

/** Parse a CUR 2.0 or FOCUS 1.0/1.2 CSV export. Never throws on data rows — rejects and discloses. */
export function parseCurCsv(text: string): CurParseResult | { readonly error: string } {
  const rows = parseCsv(text);
  if (rows.length === 0) return { error: "The file is empty" };
  if (rows.length - 1 > CUR_MAX_ROWS) return { error: `The file exceeds the maximum of ${CUR_MAX_ROWS} data rows` };
  const nonEmptyHeaderNames = rows[0].map((name) => name.trim()).filter((name) => name.length > 0);
  if (new Set(nonEmptyHeaderNames).size !== nonEmptyHeaderNames.length) {
    return { error: "The header contains duplicate column names" };
  }
  const columns = detectColumns(rows[0]);
  if (columns === null) {
    return {
      error: "The header is neither AWS CUR 2.0 (line_item_*) nor FOCUS 1.0/1.2 (BilledCost/ChargeCategory) format",
    };
  }
  const lines: CanonicalCurLine[] = [];
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

    const optionalMoney = {
      amortized: optionalMicrosFor(columns.amortized, cell, "amortized cost"),
      amortizedReservation: optionalMicrosFor(columns.amortizedReservation, cell, "reservation effective cost"),
      amortizedSavingsPlan: optionalMicrosFor(columns.amortizedSavingsPlan, cell, "Savings Plan effective cost"),
      netUnblendedCost: optionalMicrosFor(columns.netUnblendedCost, cell, "net unblended cost"),
      listCost: optionalMicrosFor(columns.listCost, cell, "list cost"),
      contractedCost: optionalMicrosFor(columns.contractedCost, cell, "contracted cost"),
      publicOnDemandCost: optionalMicrosFor(columns.publicOnDemandCost, cell, "public On-Demand cost"),
      listUnitPrice: optionalMicrosFor(columns.listUnitPrice, cell, "list unit price"),
      contractedUnitPrice: optionalMicrosFor(columns.contractedUnitPrice, cell, "contracted unit price"),
      publicOnDemandRate: optionalMicrosFor(columns.publicOnDemandRate, cell, "public On-Demand rate"),
      pricingCurrencyEffectiveCost: optionalMicrosFor(
        columns.pricingCurrencyEffectiveCost,
        cell,
        "pricing-currency effective cost",
      ),
      pricingCurrencyListUnitPrice: optionalMicrosFor(
        columns.pricingCurrencyListUnitPrice,
        cell,
        "pricing-currency list unit price",
      ),
      pricingCurrencyContractedUnitPrice: optionalMicrosFor(
        columns.pricingCurrencyContractedUnitPrice,
        cell,
        "pricing-currency contracted unit price",
      ),
    };
    const moneyError = Object.values(optionalMoney).find((result) => result.error !== null)?.error ?? null;
    if (moneyError !== null) {
      rejected.push({ rowNumber, reason: moneyError });
      continue;
    }

    const billingPeriodStart = optionalIsoFor(columns.billingPeriodStart, cell, "billing period start date");
    const billingPeriodEnd = optionalIsoFor(columns.billingPeriodEnd, cell, "billing period end date");
    const usageEnd = optionalIsoFor(columns.usageEnd, cell, "usage end date");
    const commitmentStart = optionalIsoFor(columns.commitmentStart, cell, "commitment start date");
    const commitmentExpiry = optionalIsoFor(columns.commitmentExpiry, cell, "commitment expiry date");
    const dateError = [billingPeriodStart, billingPeriodEnd, usageEnd, commitmentStart, commitmentExpiry]
      .find((result) => result.error !== null)?.error ?? null;
    if (dateError !== null) {
      rejected.push({ rowNumber, reason: dateError });
      continue;
    }
    if (
      billingPeriodStart.value !== null &&
      billingPeriodEnd.value !== null &&
      Date.parse(billingPeriodEnd.value) <= Date.parse(billingPeriodStart.value)
    ) {
      rejected.push({ rowNumber, reason: "billing period end date must be after its start date" });
      continue;
    }
    if (usageEnd.value !== null && Date.parse(usageEnd.value) <= usageStartMs) {
      rejected.push({ rowNumber, reason: "usage end date must be after its start date" });
      continue;
    }
    if (
      commitmentStart.value !== null &&
      commitmentExpiry.value !== null &&
      Date.parse(commitmentExpiry.value) <= Date.parse(commitmentStart.value)
    ) {
      rejected.push({ rowNumber, reason: "commitment expiry date must be after its start date" });
      continue;
    }

    const commitmentQuantity = optionalMicrosFor(
      columns.commitmentQuantity,
      cell,
      "commitment discount quantity",
    );
    if (commitmentQuantity.error !== null) {
      rejected.push({ rowNumber, reason: commitmentQuantity.error });
      continue;
    }

    const structuredTags = structuredStringMapFor(columns.structuredTags, cell, "tags");
    const structuredCostCategories = structuredStringMapFor(
      columns.structuredCostCategories,
      cell,
      "cost categories",
    );
    const mapError = structuredTags.error ?? structuredCostCategories.error;
    if (mapError !== null) {
      rejected.push({ rowNumber, reason: mapError });
      continue;
    }
    const tags: Record<string, string> = { ...structuredTags.value };
    let dimensionConflict: string | null = null;
    for (const tag of columns.tagColumns) {
      const value = cell(tag.index);
      if (value.length === 0) continue;
      if (tags[tag.key] !== undefined && tags[tag.key] !== value) {
        dimensionConflict = `tag '${tag.key.slice(0, 64)}' has conflicting values`;
        break;
      }
      tags[tag.key] = value;
    }
    if (dimensionConflict !== null) {
      rejected.push({ rowNumber, reason: dimensionConflict });
      continue;
    }
    const costCategories: Record<string, string> = { ...structuredCostCategories.value };
    for (const category of columns.costCategoryColumns) {
      const value = cell(category.index);
      if (value.length === 0) continue;
      if (costCategories[category.key] !== undefined && costCategories[category.key] !== value) {
        dimensionConflict = `cost category '${category.key.slice(0, 64)}' has conflicting values`;
        break;
      }
      costCategories[category.key] = value;
    }
    if (dimensionConflict !== null) {
      rejected.push({ rowNumber, reason: dimensionConflict });
      continue;
    }
    // FOCUS 1.2 places AWS Cost Categories inside Tags with this namespace.
    for (const [key, value] of Object.entries(tags)) {
      const prefix = "aws:tags:CostCategory/";
      if (!key.startsWith(prefix)) continue;
      const categoryKey = key.slice(prefix.length);
      if (
        costCategories[categoryKey] !== undefined &&
        costCategories[categoryKey] !== value
      ) {
        dimensionConflict = `cost category '${categoryKey.slice(0, 64)}' has conflicting values`;
        break;
      }
      costCategories[categoryKey] = value;
    }
    if (dimensionConflict !== null) {
      rejected.push({ rowNumber, reason: dimensionConflict });
      continue;
    }

    const providedId = cell(columns.lineItemId);
    const region = cell(columns.region);
    const chargeCategory = cell(columns.chargeCategory) || "Unspecified";
    const billType = optionalTextFor(columns.billType, cell, 64);
    const chargeKind = chargeKindFor(chargeCategory, billType);
    lines.push({
      lineItemId: providedId.length > 0 ? providedId : `row-${rowNumber}`,
      usageAccountId: account,
      service,
      chargeCategory,
      usageStartIso: new Date(usageStartMs).toISOString(),
      amountMicros,
      currency,
      region: region.length > 0 ? region : null,
      amortizedMicros: amortizedMicrosFor(columns, cell),
      commitmentType: commitmentTypeFor(columns, cell),
      commitmentId: commitmentIdFor(columns, cell),
      commitmentExpiry: commitmentExpiry.value,
      usageType: optionalTextFor(columns.usageType, cell, 256),
      usageAmountMicros: usageAmountMicrosFor(columns, cell),
      usageUnit: optionalTextFor(columns.usageUnit, cell, 64),
      tags,
      sourceFormat: columns.sourceFormat,
      sourceVersion: columns.sourceVersion,
      payerAccountId: optionalTextFor(columns.payerAccountId, cell, 128),
      payerAccountName: optionalTextFor(columns.payerAccountName, cell, 256),
      usageAccountName: optionalTextFor(columns.usageAccountName, cell, 256),
      billingPeriodStartIso: billingPeriodStart.value,
      billingPeriodEndIso: billingPeriodEnd.value,
      usageEndIso: usageEnd.value,
      invoiceId: optionalTextFor(columns.invoiceId, cell, 256),
      invoiceIssuerId: optionalTextFor(columns.invoiceIssuerId, cell, 256),
      invoiceIssuerName: optionalTextFor(columns.invoiceIssuerName, cell, 256),
      billingEntity: optionalTextFor(columns.billingEntity, cell, 256),
      legalEntity: optionalTextFor(columns.legalEntity, cell, 256),
      billType,
      resourceId: optionalTextFor(columns.resourceId, cell, 1024),
      resourceName: optionalTextFor(columns.resourceName, cell, 512),
      resourceType: optionalTextFor(columns.resourceType, cell, 256),
      availabilityZone: optionalTextFor(columns.availabilityZone, cell, 128),
      operation: optionalTextFor(columns.operation, cell, 256),
      productCode: optionalTextFor(columns.productCode, cell, 256),
      productName: optionalTextFor(columns.productName, cell, 256),
      productFamily: optionalTextFor(columns.productFamily, cell, 256),
      serviceCategory: optionalTextFor(columns.serviceCategory, cell, 256),
      serviceSubcategory: optionalTextFor(columns.serviceSubcategory, cell, 256),
      providerServiceCode: optionalTextFor(columns.providerServiceCode, cell, 256),
      providerServiceName: optionalTextFor(columns.providerServiceName, cell, 256),
      transferType: optionalTextFor(columns.transferType, cell, 512),
      fromLocation: optionalTextFor(columns.fromLocation, cell, 512),
      toLocation: optionalTextFor(columns.toLocation, cell, 512),
      fromLocationType: optionalTextFor(columns.fromLocationType, cell, 256),
      chargeClass: optionalTextFor(columns.chargeClass, cell, 128),
      chargeDescription: optionalTextFor(columns.chargeDescription, cell, 1024),
      chargeFrequency: optionalTextFor(columns.chargeFrequency, cell, 128),
      chargeKind,
      taxType: optionalTextFor(columns.taxType, cell, 128),
      taxMicros: chargeKind === "tax" ? amountMicros : null,
      creditMicros: chargeKind === "credit" ? amountMicros : null,
      refundMicros: chargeKind === "refund" ? amountMicros : null,
      netUnblendedCostMicros: optionalMoney.netUnblendedCost.value,
      listCostMicros: optionalMoney.listCost.value,
      contractedCostMicros: optionalMoney.contractedCost.value,
      publicOnDemandCostMicros: optionalMoney.publicOnDemandCost.value,
      listUnitPriceMicros: optionalMoney.listUnitPrice.value,
      contractedUnitPriceMicros: optionalMoney.contractedUnitPrice.value,
      publicOnDemandRateMicros: optionalMoney.publicOnDemandRate.value,
      pricingCurrency: optionalTextFor(columns.pricingCurrency, cell, 64),
      pricingCurrencyEffectiveCostMicros: optionalMoney.pricingCurrencyEffectiveCost.value,
      pricingCurrencyListUnitPriceMicros: optionalMoney.pricingCurrencyListUnitPrice.value,
      pricingCurrencyContractedUnitPriceMicros: optionalMoney.pricingCurrencyContractedUnitPrice.value,
      pricingCategory: optionalTextFor(columns.pricingCategory, cell, 128),
      pricingTerm: optionalTextFor(columns.pricingTerm, cell, 128),
      pricingRateId: optionalTextFor(columns.pricingRateId, cell, 256),
      commitmentName: optionalTextFor(columns.commitmentName, cell, 256),
      commitmentCategory: optionalTextFor(columns.commitmentCategory, cell, 128),
      commitmentStatus: optionalTextFor(columns.commitmentStatus, cell, 128),
      commitmentStart: commitmentStart.value,
      commitmentQuantityMicros: commitmentQuantity.value,
      commitmentUnit: optionalTextFor(columns.commitmentUnit, cell, 64),
      commitmentPurchaseOption: optionalTextFor(columns.commitmentPurchaseOption, cell, 128),
      capacityReservationId: optionalTextFor(columns.capacityReservationId, cell, 1024),
      capacityReservationStatus: optionalTextFor(columns.capacityReservationStatus, cell, 128),
      costCategories,
    });
    currencies.add(currency);
  }
  return {
    dialect: columns.dialect,
    sourceFormat: columns.sourceFormat,
    sourceVersion: columns.sourceVersion,
    lines,
    rejected,
    totalRows: rows.length - 1,
    currencies: [...currencies].sort(),
    disclaimer: CUR_PARSE_DISCLAIMER,
  };
}
