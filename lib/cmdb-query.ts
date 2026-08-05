import type { JsonValue, ResourceLifecycleState } from "./pilot-types";

/**
 * Pure, deterministic CMDB query engine.
 *
 * Evaluates a validated predicate list against normalized resources entirely
 * in memory — no eval, no dynamic code, no I/O. Unknown fields, malformed
 * predicates, and over-deep config paths are rejected at validation time and
 * reported verbatim; they never silently match or silently drop. Results are
 * evidence-honest: `truncated` discloses when a limit cut the result set.
 */

export interface CmdbQueryResource {
  readonly resourceKey: string;
  readonly service: string;
  readonly resourceType: string;
  readonly regionKey: string;
  readonly name: string | null;
  readonly state: string | null;
  readonly arn: string | null;
  readonly nativeId: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly configuration: JsonValue;
  readonly lifecycleState?: ResourceLifecycleState;
  readonly consecutiveCompleteMisses?: number;
  readonly evidenceSnapshotId?: string;
  readonly evidenceSnapshotSha256?: string;
  readonly contentSha256?: string;
}

export type CmdbScalarField =
  | "service"
  | "resourceType"
  | "regionKey"
  | "state"
  | "name"
  | "resourceKey"
  | "arn"
  | "nativeId";

export type CmdbQueryPredicate =
  | { readonly kind: "field"; readonly field: CmdbScalarField; readonly op: "eq" | "neq" | "contains" | "prefix"; readonly value: string }
  | { readonly kind: "tag"; readonly key: string; readonly op: "eq" | "neq" | "contains" | "prefix" | "exists" | "missing"; readonly value?: string }
  | { readonly kind: "config"; readonly path: string; readonly op: "eq" | "neq" | "contains" | "exists" | "missing" | "gt" | "lt"; readonly value?: string | number | boolean };

export interface CmdbQuery {
  readonly combine: "and" | "or";
  readonly predicates: readonly CmdbQueryPredicate[];
  readonly limit?: number;
}

export interface CmdbQueryValidation {
  readonly query: CmdbQuery | null;
  readonly errors: readonly string[];
}

export interface CmdbQueryResult {
  readonly matched: readonly CmdbQueryResource[];
  readonly totalMatched: number;
  readonly evaluated: number;
  readonly truncated: boolean;
}

export const CMDB_QUERY_MAX_PREDICATES = 16;
export const CMDB_QUERY_MAX_PATH_DEPTH = 8;
export const CMDB_QUERY_MAX_LIMIT = 500;
export const CMDB_QUERY_DEFAULT_LIMIT = 100;

const SCALAR_FIELDS: readonly CmdbScalarField[] = ["service", "resourceType", "regionKey", "state", "name", "resourceKey", "arn", "nativeId"];
const FIELD_OPS = new Set(["eq", "neq", "contains", "prefix"]);
const TAG_OPS = new Set(["eq", "neq", "contains", "prefix", "exists", "missing"]);
const CONFIG_OPS = new Set(["eq", "neq", "contains", "exists", "missing", "gt", "lt"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate untrusted input into a CmdbQuery. Returns every problem found. */
export function validateCmdbQuery(input: unknown): CmdbQueryValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { query: null, errors: ["query must be an object"] };
  const combine = input.combine === "or" ? "or" : input.combine === "and" || input.combine === undefined ? "and" : null;
  if (combine === null) errors.push("combine must be 'and' or 'or'");
  if (!Array.isArray(input.predicates) || input.predicates.length === 0) {
    errors.push("predicates must be a non-empty array");
    return { query: null, errors };
  }
  if (input.predicates.length > CMDB_QUERY_MAX_PREDICATES) {
    errors.push(`predicates exceeds the maximum of ${CMDB_QUERY_MAX_PREDICATES}`);
  }
  const predicates: CmdbQueryPredicate[] = [];
  input.predicates.forEach((raw, index) => {
    const label = `predicates[${index}]`;
    if (!isRecord(raw)) { errors.push(`${label} must be an object`); return; }
    const kind = raw.kind;
    if (kind === "field") {
      if (!SCALAR_FIELDS.includes(raw.field as CmdbScalarField)) { errors.push(`${label}.field is not a queryable field`); return; }
      if (!FIELD_OPS.has(String(raw.op))) { errors.push(`${label}.op is not valid for field predicates`); return; }
      if (typeof raw.value !== "string") { errors.push(`${label}.value must be a string`); return; }
      predicates.push({ kind: "field", field: raw.field as CmdbScalarField, op: raw.op as "eq", value: raw.value });
      return;
    }
    if (kind === "tag") {
      if (typeof raw.key !== "string" || raw.key.length === 0) { errors.push(`${label}.key must be a non-empty string`); return; }
      if (!TAG_OPS.has(String(raw.op))) { errors.push(`${label}.op is not valid for tag predicates`); return; }
      const needsValue = raw.op !== "exists" && raw.op !== "missing";
      if (needsValue && typeof raw.value !== "string") { errors.push(`${label}.value must be a string for op '${String(raw.op)}'`); return; }
      predicates.push({ kind: "tag", key: raw.key, op: raw.op as "eq", value: typeof raw.value === "string" ? raw.value : undefined });
      return;
    }
    if (kind === "config") {
      if (typeof raw.path !== "string" || raw.path.length === 0) { errors.push(`${label}.path must be a non-empty string`); return; }
      const depth = raw.path.split(".").length;
      if (depth > CMDB_QUERY_MAX_PATH_DEPTH) { errors.push(`${label}.path exceeds the maximum depth of ${CMDB_QUERY_MAX_PATH_DEPTH}`); return; }
      if (!CONFIG_OPS.has(String(raw.op))) { errors.push(`${label}.op is not valid for config predicates`); return; }
      const needsValue = raw.op !== "exists" && raw.op !== "missing";
      const valueOk = typeof raw.value === "string" || typeof raw.value === "number" || typeof raw.value === "boolean";
      if (needsValue && !valueOk) { errors.push(`${label}.value must be a string, number or boolean for op '${String(raw.op)}'`); return; }
      predicates.push({ kind: "config", path: raw.path, op: raw.op as "eq", value: needsValue ? (raw.value as string | number | boolean) : undefined });
      return;
    }
    errors.push(`${label}.kind must be 'field', 'tag' or 'config'`);
  });
  let limit = CMDB_QUERY_DEFAULT_LIMIT;
  if (input.limit !== undefined) {
    if (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1) errors.push("limit must be a positive integer");
    else limit = Math.min(input.limit, CMDB_QUERY_MAX_LIMIT);
  }
  if (errors.length > 0) return { query: null, errors };
  return { query: { combine: combine as "and" | "or", predicates, limit }, errors: [] };
}

function resolveConfigPath(configuration: JsonValue, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = configuration;
  for (const segment of path.split(".")) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, JsonValue>)[segment];
  }
  return current;
}

function matchString(actual: string | null, op: string, expected: string): boolean {
  if (actual === null) return op === "neq";
  const a = actual.toLowerCase();
  const e = expected.toLowerCase();
  switch (op) {
    case "eq": return a === e;
    case "neq": return a !== e;
    case "contains": return a.includes(e);
    case "prefix": return a.startsWith(e);
    default: return false;
  }
}

function matchConfig(resolved: JsonValue | undefined, op: string, expected: string | number | boolean | undefined): boolean {
  if (op === "exists") return resolved !== undefined;
  if (op === "missing") return resolved === undefined;
  if (resolved === undefined || resolved === null) return op === "neq";
  if (op === "gt" || op === "lt") {
    const actualNum = typeof resolved === "number" ? resolved : Number(resolved);
    const expectedNum = typeof expected === "number" ? expected : Number(expected);
    if (!Number.isFinite(actualNum) || !Number.isFinite(expectedNum)) return false;
    return op === "gt" ? actualNum > expectedNum : actualNum < expectedNum;
  }
  if (typeof resolved === "object") return false;
  const actual = String(resolved);
  const expectedStr = String(expected);
  if (typeof resolved === "boolean" || typeof expected === "boolean" || typeof resolved === "number" || typeof expected === "number") {
    if (op === "eq") return actual === expectedStr;
    if (op === "neq") return actual !== expectedStr;
  }
  return matchString(actual, op, expectedStr);
}

function matchPredicate(resource: CmdbQueryResource, predicate: CmdbQueryPredicate): boolean {
  if (predicate.kind === "field") return matchString(resource[predicate.field], predicate.op, predicate.value);
  if (predicate.kind === "tag") {
    const tagValue = Object.prototype.hasOwnProperty.call(resource.tags, predicate.key) ? resource.tags[predicate.key] : undefined;
    if (predicate.op === "exists") return tagValue !== undefined;
    if (predicate.op === "missing") return tagValue === undefined;
    return matchString(tagValue ?? null, predicate.op, predicate.value ?? "");
  }
  return matchConfig(resolveConfigPath(resource.configuration, predicate.path), predicate.op, predicate.value);
}

/** Run a validated query. Deterministic: same inputs, same output order. */
export function runCmdbQuery(resources: readonly CmdbQueryResource[], query: CmdbQuery): CmdbQueryResult {
  const limit = Math.min(query.limit ?? CMDB_QUERY_DEFAULT_LIMIT, CMDB_QUERY_MAX_LIMIT);
  const matched: CmdbQueryResource[] = [];
  let totalMatched = 0;
  for (const resource of resources) {
    const verdicts = query.predicates.map((predicate) => matchPredicate(resource, predicate));
    const hit = query.combine === "and" ? verdicts.every(Boolean) : verdicts.some(Boolean);
    if (!hit) continue;
    totalMatched += 1;
    if (matched.length < limit) matched.push(resource);
  }
  return { matched, totalMatched, evaluated: resources.length, truncated: totalMatched > matched.length };
}
