// Maps normalized CMDB resources into the AWS IAM CIEM engine's input. Mirrors
// the guarded extraction in kubernetes-ciem-evidence.ts: an IAM principal whose
// policy statements are not present degrades to `statements: null` (reported
// unresolved by the engine, never assumed to grant nothing), and a statement
// without an effect or an action is dropped rather than invented. Condition
// presence is carried through so the engine can surface (never evaluate) it.
import type {
  AwsIamCiemInput,
  IamPrincipal,
  IamServiceLastAccessed,
  IamStatement,
} from "./aws-iam-ciem.ts";
import type { JsonValue } from "./pilot-types.ts";

interface ResourceLike {
  readonly resourceKey: string;
  readonly service: string;
  readonly resourceType: string;
  readonly arn: string | null;
  readonly name: string | null;
  readonly configuration: Readonly<Record<string, JsonValue>>;
}

function obj(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : null;
}
function arr(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}
function str(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function strList(value: JsonValue | undefined): string[] {
  return arr(value).filter((entry): entry is string => typeof entry === "string");
}
function num(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nameOf(resource: ResourceLike): string {
  return resource.name?.trim() || str(obj(resource.configuration.metadata)?.name) || resource.resourceKey;
}

function classify(resource: ResourceLike): "role" | "user" | null {
  const value = `${resource.service} ${resource.resourceType} ${str(resource.configuration.resourceType) ?? ""}`
    .toLocaleLowerCase("en-US");
  if (!value.includes("iam")) return null;
  if (value.includes("role")) return "role";
  if (value.includes("user")) return "user";
  return null;
}

function stringOrList(primary: JsonValue | undefined, fallback: JsonValue | undefined): string[] {
  if (strList(primary).length > 0) return strList(primary);
  if (typeof primary === "string") return [primary];
  if (strList(fallback).length > 0) return strList(fallback);
  if (typeof fallback === "string") return [fallback];
  return [];
}

// Returns the parsed statements, or `null` when the resource carries no policy
// evidence at all — the engine then reports the principal unresolved rather than
// treating an uncollected policy as "grants nothing".
function extractStatements(resource: ResourceLike): readonly IamStatement[] | null {
  const documents: JsonValue[] = [];
  const single = obj(resource.configuration.policyDocument);
  if (single !== null) documents.push(single);
  for (const entry of arr(resource.configuration.policyDocuments)) documents.push(entry);
  for (const entry of arr(resource.configuration.inlinePolicies)) documents.push(entry);
  for (const entry of arr(resource.configuration.attachedPolicies)) documents.push(entry);
  const inlineStatements = arr(resource.configuration.statements);

  const hasPolicySource =
    documents.length > 0 ||
    inlineStatements.length > 0 ||
    resource.configuration.policyDocument !== undefined ||
    resource.configuration.statements !== undefined;
  if (!hasPolicySource) return null;

  const statements: IamStatement[] = [];
  const push = (raw: JsonValue) => {
    const statement = obj(raw);
    if (statement === null) return;
    const effect = str(statement.Effect) ?? str(statement.effect);
    const actions = stringOrList(statement.Action, statement.action);
    const resources = stringOrList(statement.Resource, statement.resource);
    if (effect === null || actions.length === 0) return;
    const conditionPresent = obj(statement.Condition) !== null || obj(statement.condition) !== null;
    statements.push({ effect: effect === "Deny" ? "Deny" : "Allow", actions, resources, conditionPresent });
  };
  for (const document of documents) {
    const record = obj(document);
    if (record === null) continue;
    for (const entry of arr(record.Statement ?? record.statement)) push(entry);
  }
  for (const entry of inlineStatements) push(entry);
  return statements;
}

function lastUsedDays(resource: ResourceLike): number | null {
  return num(resource.configuration.serviceLastUsedDays)
    ?? num(resource.configuration.lastUsedDays)
    ?? num(obj(resource.configuration.lastAccessed)?.serviceLastUsedDays);
}

export function deriveAwsIamPrincipals(resources: readonly ResourceLike[]): AwsIamCiemInput {
  const principals: IamPrincipal[] = [];
  const lastAccessed: Record<string, IamServiceLastAccessed> = {};
  for (const resource of resources) {
    const kind = classify(resource);
    if (kind === null) continue;
    const ref = resource.arn ?? nameOf(resource);
    principals.push({ ref, kind, statements: extractStatements(resource), tenant: null });
    const days = lastUsedDays(resource);
    if (days !== null) lastAccessed[ref] = { serviceLastUsedDays: days };
  }
  return { principals, lastAccessed };
}
