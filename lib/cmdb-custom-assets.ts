// Pure, deterministic ingestion + shaping for CUSTOM / EXTERNAL assets — the
// user-supplied SaaS apps, network devices, and on-prem/non-cloud items that
// broaden CMDB coverage beyond what AWS discovery can see. Nothing here touches
// AWS or performs I/O: these assets are brought in by the operator via CSV/JSON
// import or a manual create, never discovered.
//
// Evidence honesty is the contract of this module:
//   - Every asset is labeled by `source` ("imported" for a bulk import,
//     "manual" for a single create) so a viewer always knows how it entered.
//   - Malformed import rows are REJECTED AND DISCLOSED (row number + reason);
//     they are never silently dropped and never "repaired" by guessing.
//   - Fields are a flat string map taken verbatim from the input; no field is
//     ever fabricated. A scalar (number/boolean) is stringified as-is; a nested
//     object/array is rejected rather than flattened into invented text.
//
// `toCmdbResource` maps a normalized asset into a PilotResource-compatible shape
// so imported assets can later join the CMDB query engine and relationship graph
// alongside collected AWS resources.

import type { JsonValue } from "./pilot-types";

/** Built-in asset types offered in the UI. `asset_type` is not limited to these
 * — any value matching {@link ASSET_TYPE} is accepted so operators can model
 * their own categories ("custom" is the free-form catch-all). */
export const BUILTIN_ASSET_TYPES = [
  "saas-app",
  "network-device",
  "on-prem-server",
  "custom",
] as const;

export type CustomAssetSource = "imported" | "manual";

export const MAX_IMPORT_ROWS = 2_000;
export const MAX_FIELDS = 50;
export const MAX_NAME_LENGTH = 200;
export const MAX_FIELD_KEY_LENGTH = 64;
export const MAX_FIELD_VALUE_LENGTH = 512;
export const MAX_EXTERNAL_ID_LENGTH = 128;

// Machine-friendly, lowercase, hyphenated. Matches every built-in type and any
// operator-defined category, but keeps the column from carrying free text.
const ASSET_TYPE = /^[a-z][a-z0-9-]{0,47}$/u;
// Field keys and external ids share a bounded, punctuation-tolerant charset.
const FIELD_KEY = /^[A-Za-z0-9][A-Za-z0-9 ._:/@+-]{0,63}$/u;
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9 ._:/@+-]{0,127}$/u;

/** Names must not span lines or carry any C0 control character or DEL. */
function hasNameControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Field values may hold tab / newline / carriage-return (multi-line notes) but
 * no other C0 control character or DEL. */
function hasFieldControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const RESERVED_NAME_KEYS = new Set(["name"]);
const RESERVED_EXTERNAL_ID_KEYS = new Set(["external_id", "externalid"]);

export interface NormalizedCustomAsset {
  readonly assetType: string;
  readonly name: string;
  readonly source: CustomAssetSource;
  readonly externalId: string | null;
  readonly fields: Readonly<Record<string, string>>;
}

export interface RejectedAssetRow {
  /** 1-based source position. For CSV this is the file LINE number (the header
   * is line 1, so data rows begin at 2). For JSON it is the 1-based array index.
   * Row 0 marks an import-level problem (bad type, header, or malformed input),
   * not a specific record. */
  readonly row: number;
  readonly reason: string;
}

export interface CustomAssetImportResult {
  readonly assets: readonly NormalizedCustomAsset[];
  readonly rejected: readonly RejectedAssetRow[];
}

export interface CustomAssetImportRequest {
  readonly format: "csv" | "json";
  readonly data: string;
  readonly assetType: string;
}

export interface SingleAssetInput {
  readonly assetType: string;
  readonly name: unknown;
  readonly externalId?: unknown;
  readonly fields?: unknown;
}

export type NormalizeOutcome =
  | { readonly ok: true; readonly asset: NormalizedCustomAsset }
  | { readonly ok: false; readonly reason: string };

/** A PilotResource-compatible projection. It carries the union of the fields the
 * CMDB query engine (`regionKey`) and the collected-resource model (`region`,
 * `source`) expect, so the parent can adapt it to either without guessing. The
 * shape is deterministic and pure — no timestamp or content hash is invented
 * here; the caller that merges it into a snapshot supplies those. */
export interface CustomAssetResource {
  readonly resourceKey: string;
  readonly service: string;
  readonly resourceType: string;
  readonly nativeId: string;
  readonly arn: string | null;
  readonly name: string;
  readonly region: string;
  readonly regionKey: string;
  readonly state: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly source: {
    readonly kind: "custom-asset";
    readonly origin: CustomAssetSource;
    readonly assetType: string;
    readonly externalId: string | null;
  };
}

export function isValidAssetType(value: unknown): value is string {
  return typeof value === "string" && ASSET_TYPE.test(value);
}

export function isValidAssetName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= MAX_NAME_LENGTH && !hasNameControlChar(trimmed);
}

/**
 * RFC-4180 CSV parser: double-quoted fields, doubled-quote escapes, and embedded
 * commas / quotes / newlines inside quoted fields; tolerates both LF and CRLF.
 * Deterministic and allocation-simple — no regex, no backtracking. A trailing
 * empty line is not emitted as a row.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let sawField = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      sawField = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      sawField = true;
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.length > 1 || row[0] !== "" || sawField) rows.push(row);
      row = [];
      field = "";
      sawField = false;
      continue;
    }
    field += char;
    sawField = true;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "" || sawField) rows.push(row);
  return rows;
}

function normalizeFields(
  entries: readonly (readonly [string, unknown])[],
): { readonly ok: true; readonly fields: Record<string, string> } | { readonly ok: false; readonly reason: string } {
  const fields: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    if (key.length === 0) continue;
    if (!FIELD_KEY.test(key)) {
      return { ok: false, reason: `field key '${key.slice(0, 32)}' is invalid` };
    }
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      return { ok: false, reason: `duplicate field key '${key}'` };
    }
    let value: string;
    if (typeof rawValue === "string") {
      value = rawValue;
    } else if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      value = String(rawValue);
    } else if (typeof rawValue === "boolean") {
      value = String(rawValue);
    } else if (rawValue === null || rawValue === undefined) {
      continue; // an absent value is not a fabricated empty field.
    } else {
      return { ok: false, reason: `field '${key}' must be a scalar value` };
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) continue; // empty cells carry no field.
    if (trimmed.length > MAX_FIELD_VALUE_LENGTH) {
      return { ok: false, reason: `field '${key}' exceeds ${MAX_FIELD_VALUE_LENGTH} characters` };
    }
    if (hasFieldControlChar(trimmed)) {
      return { ok: false, reason: `field '${key}' contains control characters` };
    }
    if (Object.keys(fields).length >= MAX_FIELDS) {
      return { ok: false, reason: `more than ${MAX_FIELDS} fields` };
    }
    fields[key] = trimmed;
  }
  return { ok: true, fields };
}

function buildAsset(input: {
  readonly assetType: string;
  readonly name: unknown;
  readonly externalId: unknown;
  readonly fieldEntries: readonly (readonly [string, unknown])[];
  readonly source: CustomAssetSource;
}): NormalizeOutcome {
  if (!isValidAssetType(input.assetType)) {
    return { ok: false, reason: `asset type '${String(input.assetType).slice(0, 32)}' is invalid` };
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    return { ok: false, reason: "name is required" };
  }
  const name = input.name.trim();
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: `name exceeds ${MAX_NAME_LENGTH} characters` };
  }
  if (hasNameControlChar(name)) {
    return { ok: false, reason: "name contains control characters" };
  }

  let externalId: string | null = null;
  if (input.externalId !== undefined && input.externalId !== null && input.externalId !== "") {
    if (typeof input.externalId !== "string") {
      return { ok: false, reason: "external id must be a string" };
    }
    const trimmed = input.externalId.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > MAX_EXTERNAL_ID_LENGTH || !EXTERNAL_ID.test(trimmed)) {
        return { ok: false, reason: "external id is invalid" };
      }
      externalId = trimmed;
    }
  }

  const normalizedFields = normalizeFields(input.fieldEntries);
  if (!normalizedFields.ok) return { ok: false, reason: normalizedFields.reason };

  return {
    ok: true,
    asset: { assetType: input.assetType, name, source: input.source, externalId, fields: normalizedFields.fields },
  };
}

/** Validate a single operator-entered asset (the manual "Add" path). Pure. */
export function normalizeCustomAsset(input: SingleAssetInput, source: CustomAssetSource = "manual"): NormalizeOutcome {
  let fieldEntries: readonly (readonly [string, unknown])[] = [];
  if (input.fields !== undefined && input.fields !== null) {
    if (typeof input.fields !== "object" || Array.isArray(input.fields)) {
      return { ok: false, reason: "fields must be an object" };
    }
    fieldEntries = Object.entries(input.fields as Record<string, unknown>);
  }
  return buildAsset({
    assetType: input.assetType,
    name: input.name,
    externalId: input.externalId,
    fieldEntries,
    source,
  });
}

function importLevelReject(reason: string): CustomAssetImportResult {
  return { assets: [], rejected: [{ row: 0, reason }] };
}

function parseCsvImport(data: string, assetType: string): CustomAssetImportResult {
  const rows = parseCsvRows(data);
  if (rows.length === 0) {
    return importLevelReject("the CSV import is empty");
  }
  const header = rows[0].map((column) => column.trim());
  // Locate the required `name` column and the optional external-id column;
  // every other column becomes a field. Duplicate columns are a header error.
  const seen = new Set<string>();
  let nameIndex = -1;
  let externalIdIndex = -1;
  const fieldColumns: { readonly index: number; readonly key: string }[] = [];
  for (let index = 0; index < header.length; index += 1) {
    const column = header[index];
    const lower = column.toLowerCase();
    if (seen.has(lower)) {
      return importLevelReject(`duplicate column '${column.slice(0, 32)}' in the header row`);
    }
    seen.add(lower);
    if (RESERVED_NAME_KEYS.has(lower)) {
      nameIndex = index;
    } else if (RESERVED_EXTERNAL_ID_KEYS.has(lower)) {
      externalIdIndex = index;
    } else if (column.length > 0) {
      fieldColumns.push({ index, key: column });
    }
  }
  if (nameIndex === -1) {
    return importLevelReject("the header row must include a 'name' column");
  }

  const assets: NormalizedCustomAsset[] = [];
  const rejected: RejectedAssetRow[] = [];
  const namesSeen = new Set<string>();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const line = rowIndex + 1; // file line number (header is line 1).
    if (rowIndex > MAX_IMPORT_ROWS) {
      rejected.push({ row: line, reason: `the import exceeds the maximum of ${MAX_IMPORT_ROWS} rows` });
      continue;
    }
    const cells = rows[rowIndex];
    if (cells.length !== header.length) {
      rejected.push({ row: line, reason: `row has ${cells.length} columns but the header defines ${header.length}` });
      continue;
    }
    const fieldEntries = fieldColumns.map((column) => [column.key, cells[column.index]] as const);
    const outcome = buildAsset({
      assetType,
      name: cells[nameIndex],
      externalId: externalIdIndex === -1 ? null : cells[externalIdIndex],
      fieldEntries,
      source: "imported",
    });
    if (!outcome.ok) {
      rejected.push({ row: line, reason: outcome.reason });
      continue;
    }
    if (namesSeen.has(outcome.asset.name)) {
      rejected.push({ row: line, reason: `duplicate name '${outcome.asset.name}' in the import` });
      continue;
    }
    namesSeen.add(outcome.asset.name);
    assets.push(outcome.asset);
  }
  return { assets, rejected };
}

function parseJsonImport(data: string, assetType: string): CustomAssetImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return importLevelReject("the JSON import is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    return importLevelReject("the JSON import must be an array of asset objects");
  }
  if (parsed.length > MAX_IMPORT_ROWS) {
    return importLevelReject(`the import exceeds the maximum of ${MAX_IMPORT_ROWS} rows`);
  }
  const assets: NormalizedCustomAsset[] = [];
  const rejected: RejectedAssetRow[] = [];
  const namesSeen = new Set<string>();
  parsed.forEach((record, index) => {
    const row = index + 1;
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      rejected.push({ row, reason: "record must be a JSON object" });
      return;
    }
    const object = record as Record<string, unknown>;
    let name: unknown;
    let externalId: unknown = null;
    const fieldEntries: [string, unknown][] = [];
    for (const [key, value] of Object.entries(object)) {
      const lower = key.trim().toLowerCase();
      if (RESERVED_NAME_KEYS.has(lower)) {
        name = value;
      } else if (RESERVED_EXTERNAL_ID_KEYS.has(lower)) {
        externalId = value;
      } else {
        fieldEntries.push([key, value]);
      }
    }
    const outcome = buildAsset({ assetType, name, externalId, fieldEntries, source: "imported" });
    if (!outcome.ok) {
      rejected.push({ row, reason: outcome.reason });
      return;
    }
    if (namesSeen.has(outcome.asset.name)) {
      rejected.push({ row, reason: `duplicate name '${outcome.asset.name}' in the import` });
      return;
    }
    namesSeen.add(outcome.asset.name);
    assets.push(outcome.asset);
  });
  return { assets, rejected };
}

/**
 * Parse a pasted CSV or JSON import into normalized custom assets plus a fully
 * disclosed list of rejected rows. Never throws on bad content and never drops a
 * row silently: a bad row appears in `rejected` with its source position and a
 * human reason. All imported assets are labeled `source: "imported"`.
 */
export function parseAssetImport(request: CustomAssetImportRequest): CustomAssetImportResult {
  if (!isValidAssetType(request.assetType)) {
    return importLevelReject(`asset type '${String(request.assetType).slice(0, 32)}' is invalid`);
  }
  if (typeof request.data !== "string" || request.data.trim().length === 0) {
    return importLevelReject("the import is empty");
  }
  if (request.format === "csv") return parseCsvImport(request.data, request.assetType);
  if (request.format === "json") return parseJsonImport(request.data, request.assetType);
  return importLevelReject("the import format must be 'csv' or 'json'");
}

/**
 * Project a normalized asset into a PilotResource-compatible resource so it can
 * appear in the CMDB query engine and relationship graph. Deterministic: the
 * same asset always yields the same resource. The user's fields become both the
 * `tags` map (queryable as tags) and part of `configuration` (queryable by
 * config path); the `source` marker records that this is a user-supplied asset,
 * never a discovered one.
 */
export function toCmdbResource(asset: NormalizedCustomAsset): CustomAssetResource {
  const tags: Record<string, string> = { ...asset.fields };
  const configuration: Record<string, JsonValue> = {
    source: asset.source,
    assetType: asset.assetType,
    externalId: asset.externalId,
    fields: { ...asset.fields },
  };
  return {
    resourceKey: `custom:${asset.assetType}:${asset.name}`,
    service: asset.assetType,
    resourceType: asset.assetType,
    nativeId: asset.externalId ?? asset.name,
    arn: null,
    name: asset.name,
    region: "custom",
    regionKey: "custom",
    // These assets are registered, not observed, so their operational state is
    // genuinely unknown — we do not invent a "running"/"available" state.
    state: "unknown",
    tags,
    configuration,
    source: {
      kind: "custom-asset",
      origin: asset.source,
      assetType: asset.assetType,
      externalId: asset.externalId,
    },
  };
}
