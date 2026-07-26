/**
 * External cost sources ("total spend, not just AWS"): a pure, deterministic
 * normalizer for operator-supplied cost records — licence invoices, support
 * contracts, third-party SaaS bills, an MSP's own managed-service fee, or a
 * CSV/JSON export from another billing system.
 *
 * Why this exists: an MSP bills a customer for AWS PLUS everything around it.
 * Showback and MSP margin that only see the CUR describe an incomplete cost
 * base. These records close that gap — without pretending to be an invoice.
 *
 * Honesty rules mirror `lib/finops-cur.ts` exactly:
 *   - Money is parsed from decimal strings into integer micro-units (bigint-safe
 *     decimal strings). There is NO float money math anywhere in this file.
 *   - Currencies are carried per record and NEVER summed across currencies.
 *   - Malformed rows are REJECTED AND DISCLOSED with their row number and a
 *     reason. Nothing is silently dropped and nothing is "repaired" by guessing.
 *   - A hard row cap rejects the WHOLE file rather than truncating it, because a
 *     truncated cost file is a wrong number that looks like a right one.
 *   - Column/field names are taken from an EXPLICIT operator-supplied mapping.
 *     Header names are never guessed: guessing which column is "the amount" is
 *     how you silently mis-bill someone.
 *   - Every result carries a disclaimer: these are operator-ASSERTED costs, not
 *     reconciled invoices.
 */

import { parseCsv, toMicros } from "./finops-cur.ts";

/** Operator-supplied mapping from this file's own column/field names to our fields. */
export interface ExternalCostMapping {
  /** Column/field holding the billing period (YYYY-MM, or YYYY-MM-DD taken to its month). Required. */
  readonly period: string;
  /** Column/field holding the amount as a decimal string. Required. */
  readonly amount: string;
  /** Column/field holding the 3-letter currency. Required unless `defaultCurrency` is given. */
  readonly currency?: string;
  /** Column/field holding the source label. Required unless `defaultSource` is given. */
  readonly source?: string;
  /** Optional: column/field naming the customer this cost is attributed to. */
  readonly customerId?: string;
  /** Optional: column/field holding a cost category (e.g. "licence", "support"). */
  readonly category?: string;
  /** Optional: column/field holding the vendor name. */
  readonly vendor?: string;
  /** Optional: column/field holding free-form tags, as a JSON object or `k=v;k=v`. */
  readonly tags?: string;
}

export const EXTERNAL_COST_MAPPING_KEYS = [
  "period", "amount", "currency", "source", "customerId", "category", "vendor", "tags",
] as const;

export const EXTERNAL_COST_REQUIRED_MAPPING_KEYS = ["period", "amount"] as const;

export interface ExternalCostDefaults {
  /** Literal currency asserted for every record that has no mapped currency column. */
  readonly defaultCurrency?: string;
  /** Literal source label asserted for every record that has no mapped source column. */
  readonly defaultSource?: string;
}

export interface NormalizedExternalCost {
  readonly period: string; // YYYY-MM
  readonly amountMicros: string; // integer micro-units as a decimal string (bigint-safe)
  readonly currency: string; // 3-letter uppercase
  readonly source: string; // operator's label for the billing source
  readonly attributedCustomer: string | null; // operator-asserted customer attribution; null when the file carries none
  readonly category: string | null;
  readonly vendor: string | null;
  readonly tags: Readonly<Record<string, string>>;
}

export interface RejectedExternalCostRow {
  readonly rowNumber: number; // 1-based data-row number (the CSV header is row 0)
  readonly reason: string;
}

export interface ExternalCostSourceTotal {
  readonly source: string;
  readonly period: string;
  readonly currency: string;
  readonly amountMicros: string;
  readonly recordCount: number;
}

export interface ExternalCostParseResult {
  readonly format: "csv" | "json";
  readonly records: readonly NormalizedExternalCost[];
  readonly rejected: readonly RejectedExternalCostRow[];
  readonly totalRows: number;
  readonly currencies: readonly string[];
  readonly sources: readonly string[];
  readonly periods: readonly string[];
  readonly totals: readonly ExternalCostSourceTotal[];
  readonly disclaimer: string;
}

export const EXTERNAL_COST_DISCLAIMER =
  "External cost records are OPERATOR-ASSERTED costs, not reconciled invoices: Sutra stores the " +
  "amounts, periods and currencies you supplied and sums them only within a single currency. " +
  "Nothing here is fetched from, verified against, or reconciled with a vendor bill. Rejected rows " +
  "are listed and excluded — they are never estimated, and no amount is ever inferred.";

/** Hard cap. A file above this is rejected WHOLE — never truncated. */
export const EXTERNAL_COST_MAX_ROWS = 20_000;

/**
 * Cap on the raw upload payload. Kept below MAX_CONFIGURABLE_JSON_BODY_LIMIT
 * (3 MiB) with room for the JSON envelope and mapping, so the route's
 * readBoundedJson limit is a legal one.
 */
export const EXTERNAL_COST_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

const PERIOD = /^(\d{4}-(?:0[1-9]|1[0-2]))(?:-\d{2})?$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const SOURCE_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._:/+&()-]{0,63}$/u;
const FIELD_NAME = /^[\p{L}\p{N}][^\r\n]{0,127}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const MAX_TEXT = 128;
const MAX_TAGS = 24;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the operator's mapping. Returns an error string rather than throwing:
 * a bad mapping is a whole-file rejection, disclosed to the operator verbatim.
 */
export function validateExternalCostMapping(
  mapping: unknown,
  defaults: ExternalCostDefaults = {},
): { readonly mapping: ExternalCostMapping } | { readonly error: string } {
  if (!isRecord(mapping)) return { error: "The column mapping must be a JSON object, e.g. { \"amount\": \"Total\", \"period\": \"Month\" }" };
  for (const key of Object.keys(mapping)) {
    if (!(EXTERNAL_COST_MAPPING_KEYS as readonly string[]).includes(key)) {
      return { error: `The mapping field "${key.slice(0, 32)}" is not recognized; accepted fields are ${EXTERNAL_COST_MAPPING_KEYS.join(", ")}` };
    }
    const value = mapping[key];
    if (typeof value !== "string" || !FIELD_NAME.test(value)) {
      return { error: `The mapping for "${key}" must name a column/field in your file` };
    }
  }
  for (const key of EXTERNAL_COST_REQUIRED_MAPPING_KEYS) {
    if (typeof mapping[key] !== "string") return { error: `The mapping must name the column/field holding the ${key}` };
  }
  if (typeof mapping.currency !== "string" && defaults.defaultCurrency === undefined) {
    return { error: "Map a currency column, or assert one currency for the whole file — a currency is never assumed" };
  }
  if (typeof mapping.source !== "string" && defaults.defaultSource === undefined) {
    return { error: "Map a source column, or label the whole file with one source name" };
  }
  if (defaults.defaultCurrency !== undefined && !CURRENCY.test(defaults.defaultCurrency)) {
    return { error: "The asserted currency must be a 3-letter code, e.g. USD" };
  }
  if (defaults.defaultSource !== undefined && !SOURCE_LABEL.test(defaults.defaultSource)) {
    return { error: "The source label must be 1-64 characters of letters, numbers, spaces or . _ : / + & ( ) -" };
  }
  return { mapping: mapping as unknown as ExternalCostMapping };
}

/** Parse a tags cell: a JSON object of string values, or `k=v;k=v`. Returns null when unusable. */
function parseTags(raw: string): Record<string, string> | null {
  const text = raw.trim();
  if (text.length === 0) return {};
  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isRecord(parsed)) return null;
    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") return null;
      if (key.length === 0 || key.length > MAX_TEXT) return null;
      tags[key] = value.slice(0, MAX_TEXT);
    }
    return Object.keys(tags).length > MAX_TAGS ? null : tags;
  }
  const tags: Record<string, string> = {};
  for (const pair of text.split(";")) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) return null;
    const key = trimmed.slice(0, separator).trim();
    if (key.length === 0 || key.length > MAX_TEXT) return null;
    tags[key] = trimmed.slice(separator + 1).trim().slice(0, MAX_TEXT);
  }
  return Object.keys(tags).length > MAX_TAGS ? null : tags;
}

function optionalText(raw: string): string | null {
  const text = raw.trim();
  return text.length === 0 ? null : text.slice(0, MAX_TEXT);
}

/**
 * Normalize one already-flattened row. `read(field)` returns the raw cell for a
 * mapped field name, or "" when the file has no value there. Returns the record
 * or a rejection reason — never a partially-populated record.
 */
function normalizeRow(
  mapping: ExternalCostMapping,
  defaults: ExternalCostDefaults,
  read: (field: string) => string,
): NormalizedExternalCost | { readonly reason: string } {
  const periodRaw = read(mapping.period).trim();
  const periodMatch = PERIOD.exec(periodRaw);
  if (periodMatch === null) {
    return { reason: `period '${periodRaw.slice(0, 32)}' is not a YYYY-MM (or YYYY-MM-DD) billing period` };
  }
  const amountRaw = read(mapping.amount).trim();
  const amountMicros = toMicros(amountRaw);
  if (amountMicros === null) {
    return { reason: `amount '${amountRaw.slice(0, 32)}' is not a decimal number` };
  }
  const currencyRaw = mapping.currency === undefined ? "" : read(mapping.currency).trim();
  const currency = (currencyRaw.length > 0 ? currencyRaw : defaults.defaultCurrency ?? "").toUpperCase();
  if (!CURRENCY.test(currency)) {
    return { reason: "currency is missing or not a 3-letter code" };
  }
  const sourceRaw = mapping.source === undefined ? "" : read(mapping.source).trim();
  const source = sourceRaw.length > 0 ? sourceRaw : defaults.defaultSource ?? "";
  if (!SOURCE_LABEL.test(source)) {
    return { reason: "source label is missing or not a usable name" };
  }
  const attributedRaw = mapping.customerId === undefined ? "" : read(mapping.customerId).trim();
  if (attributedRaw.length > 0 && !IDENTIFIER.test(attributedRaw)) {
    return { reason: `customer attribution '${attributedRaw.slice(0, 32)}' is not a valid customer identifier` };
  }
  const tags = mapping.tags === undefined ? {} : parseTags(read(mapping.tags));
  if (tags === null) {
    return { reason: "tags are neither a JSON object of text values nor 'key=value;key=value' pairs" };
  }
  return {
    period: periodMatch[1],
    amountMicros,
    currency,
    source,
    attributedCustomer: attributedRaw.length > 0 ? attributedRaw : null,
    category: mapping.category === undefined ? null : optionalText(read(mapping.category)),
    vendor: mapping.vendor === undefined ? null : optionalText(read(mapping.vendor)),
    tags,
  };
}

/** Deterministic per-(source, period, currency) totals. bigint sums only, never across currencies. */
export function summarizeExternalCosts(
  records: readonly NormalizedExternalCost[],
): readonly ExternalCostSourceTotal[] {
  const buckets = new Map<string, { source: string; period: string; currency: string; micros: bigint; count: number }>();
  for (const record of records) {
    const key = `${record.source} ${record.period} ${record.currency}`;
    const entry = buckets.get(key)
      ?? { source: record.source, period: record.period, currency: record.currency, micros: BigInt(0), count: 0 };
    entry.micros += BigInt(record.amountMicros);
    entry.count += 1;
    buckets.set(key, entry);
  }
  return [...buckets.values()]
    .map((entry) => ({
      source: entry.source,
      period: entry.period,
      currency: entry.currency,
      amountMicros: entry.micros.toString(),
      recordCount: entry.count,
    }))
    .sort((a, b) =>
      b.period.localeCompare(a.period, "en-US") ||
      a.source.localeCompare(b.source, "en-US") ||
      a.currency.localeCompare(b.currency, "en-US"));
}

function finalize(
  format: "csv" | "json",
  records: readonly NormalizedExternalCost[],
  rejected: readonly RejectedExternalCostRow[],
  totalRows: number,
): ExternalCostParseResult {
  return {
    format,
    records,
    rejected,
    totalRows,
    currencies: [...new Set(records.map((record) => record.currency))].sort((a, b) => a.localeCompare(b, "en-US")),
    sources: [...new Set(records.map((record) => record.source))].sort((a, b) => a.localeCompare(b, "en-US")),
    periods: [...new Set(records.map((record) => record.period))].sort((a, b) => b.localeCompare(a, "en-US")),
    totals: summarizeExternalCosts(records),
    disclaimer: EXTERNAL_COST_DISCLAIMER,
  };
}

/**
 * Parse an operator CSV export using an explicit column mapping. Column names
 * are never guessed: a mapped column missing from the header rejects the whole
 * file, naming the column, so the operator fixes the mapping instead of getting
 * a plausible-looking wrong total.
 */
export function parseExternalCostCsv(
  text: string,
  mapping: ExternalCostMapping,
  defaults: ExternalCostDefaults = {},
): ExternalCostParseResult | { readonly error: string } {
  const rows = parseCsv(text, EXTERNAL_COST_MAX_ROWS + 2);
  if (rows.length === 0) return { error: "The file is empty" };
  if (rows.length - 1 > EXTERNAL_COST_MAX_ROWS) {
    return { error: `The file exceeds the maximum of ${EXTERNAL_COST_MAX_ROWS} data rows; nothing was ingested — split the file rather than truncating it` };
  }
  const header = rows[0].map((name) => name.trim());
  const indexByName = new Map<string, number>();
  for (let index = 0; index < header.length; index += 1) {
    if (!indexByName.has(header[index])) indexByName.set(header[index], index);
  }
  const mapped = new Map<string, number>();
  for (const key of EXTERNAL_COST_MAPPING_KEYS) {
    const column = mapping[key];
    if (typeof column !== "string") continue;
    const index = indexByName.get(column.trim());
    if (index === undefined) {
      return { error: `The mapped column "${column.slice(0, 48)}" (for ${key}) is not in the file header; the header is not guessed at` };
    }
    mapped.set(column, index);
  }
  const records: NormalizedExternalCost[] = [];
  const rejected: RejectedExternalCostRow[] = [];
  for (let rowNumber = 1; rowNumber < rows.length; rowNumber += 1) {
    const row = rows[rowNumber];
    const read = (field: string): string => {
      const index = mapped.get(field);
      return index !== undefined && index < row.length ? row[index] : "";
    };
    const outcome = normalizeRow(mapping, defaults, read);
    if ("reason" in outcome) rejected.push({ rowNumber, reason: outcome.reason });
    else records.push(outcome);
  }
  return finalize("csv", records, rejected, rows.length - 1);
}

/**
 * Parse operator-supplied JSON records (an array of flat objects) using the same
 * explicit mapping. Only string/number/boolean-free scalar cells are read; a
 * nested object or array under a mapped field rejects that row, disclosed.
 */
export function parseExternalCostJson(
  input: unknown,
  mapping: ExternalCostMapping,
  defaults: ExternalCostDefaults = {},
): ExternalCostParseResult | { readonly error: string } {
  const rows = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.records)
      ? input.records
      : null;
  if (rows === null) return { error: "The JSON payload must be an array of records, or an object with a `records` array" };
  if (rows.length === 0) return { error: "The file is empty" };
  if (rows.length > EXTERNAL_COST_MAX_ROWS) {
    return { error: `The file exceeds the maximum of ${EXTERNAL_COST_MAX_ROWS} data rows; nothing was ingested — split the file rather than truncating it` };
  }
  const records: NormalizedExternalCost[] = [];
  const rejected: RejectedExternalCostRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = index + 1;
    const row: unknown = rows[index];
    if (!isRecord(row)) {
      rejected.push({ rowNumber, reason: "the record is not a JSON object" });
      continue;
    }
    // A structural (object/array/boolean) cell under a mapped field is a
    // rejection, not a guess. Collected in an array because the closure below
    // records it and a captured `let` would not narrow.
    const nested: string[] = [];
    const read = (field: string): string => {
      const value: unknown = row[field];
      if (value === undefined || value === null) return "";
      if (typeof value === "string") return value;
      // A number cell is stringified exactly as authored by JSON.parse; that
      // string then goes through the same decimal parser, so no float math
      // touches the money. Anything structural is a rejection, not a guess.
      if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NaN";
      if (typeof value === "boolean") { nested.push(field); return ""; }
      if (field === mapping.tags && isRecord(value)) return JSON.stringify(value);
      nested.push(field);
      return "";
    };
    const outcome = normalizeRow(mapping, defaults, read);
    if (nested.length > 0) {
      rejected.push({ rowNumber, reason: `field '${nested[0].slice(0, 32)}' is not a text or numeric value` });
      continue;
    }
    if ("reason" in outcome) rejected.push({ rowNumber, reason: outcome.reason });
    else records.push(outcome);
  }
  return finalize("json", records, rejected, rows.length);
}

/* -------------------------------------------------------------------------- */
/* Ingest request body                                                         */
/* -------------------------------------------------------------------------- */

export interface ExternalCostIngestRequest {
  readonly connectionId: string;
  readonly format: "csv" | "json";
  readonly csv: string | null;
  readonly records: unknown;
  readonly mapping: ExternalCostMapping;
  readonly defaults: ExternalCostDefaults;
}

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const INGEST_BODY_KEYS = ["connectionId", "format", "csv", "records", "mapping", "defaultCurrency", "defaultSource"] as const;
// Fields a caller must never be able to propose: the tenant is resolved
// server-side from the session and the connection row. These are named
// explicitly so the rejection message says WHY, rather than "unknown field".
const TENANT_BODY_KEYS = ["orgId", "org_id", "customerId", "customer_id", "tenant", "tenantId", "subject"] as const;

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_INPUT", status: 400 });
}

/**
 * Parse and validate an ingest body. The tenant is NOT part of the contract: a
 * body carrying orgId/customerId/tenant is REJECTED (not ignored), so a caller
 * cannot even propose which tenant its costs land in and cannot believe it did.
 */
export function parseExternalCostIngestBody(body: unknown): ExternalCostIngestRequest {
  if (!isRecord(body)) invalid("The external cost upload must be a JSON object");
  for (const key of TENANT_BODY_KEYS) {
    if (key in body) {
      invalid(`The field "${key}" is not accepted: the tenant is resolved from your session and the selected connection, never from the request body`);
    }
  }
  for (const key of Object.keys(body)) {
    if (!(INGEST_BODY_KEYS as readonly string[]).includes(key)) {
      invalid(`The field "${key.slice(0, 32)}" is not accepted; accepted fields are ${INGEST_BODY_KEYS.join(", ")}`);
    }
  }
  const { connectionId, format, csv, records, mapping, defaultCurrency, defaultSource } = body;
  if (typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId)) invalid("The connection identifier is invalid");
  if (format !== "csv" && format !== "json") invalid('The format must be "csv" or "json"');
  if (format === "csv") {
    if (typeof csv !== "string" || csv.length === 0) invalid("Provide the CSV export as `csv` text");
    if (csv.length > EXTERNAL_COST_MAX_UPLOAD_BYTES) invalid("The CSV export is too large; split it by period or source");
  } else if (records === undefined || records === null) {
    invalid("Provide the parsed JSON export as `records`");
  }
  if (defaultCurrency !== undefined && typeof defaultCurrency !== "string") invalid("The asserted currency must be a 3-letter code, e.g. USD");
  if (defaultSource !== undefined && typeof defaultSource !== "string") invalid("The source label must be text");
  const defaults: ExternalCostDefaults = {
    defaultCurrency: typeof defaultCurrency === "string" && defaultCurrency.length > 0 ? defaultCurrency.trim().toUpperCase() : undefined,
    defaultSource: typeof defaultSource === "string" && defaultSource.length > 0 ? defaultSource.trim() : undefined,
  };
  const validated = validateExternalCostMapping(mapping, defaults);
  if ("error" in validated) invalid(validated.error);
  return {
    connectionId,
    format,
    csv: format === "csv" ? (csv as string) : null,
    records: format === "json" ? records : null,
    mapping: validated.mapping,
    defaults,
  };
}

/** Run the parser the request asked for. Pure; whole-file errors come back as `{ error }`. */
export function parseExternalCostRequest(
  request: ExternalCostIngestRequest,
): ExternalCostParseResult | { readonly error: string } {
  return request.format === "csv"
    ? parseExternalCostCsv(request.csv ?? "", request.mapping, request.defaults)
    : parseExternalCostJson(request.records, request.mapping, request.defaults);
}
