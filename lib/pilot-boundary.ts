import { parseAwsAccountId, parseAwsPartition, parseIamRoleArn } from "./aws-pilot-security.ts";
import type {
  AwsPartition,
  AwsPermissionCapabilityAssessment,
  CollectorHealth,
  CoverageStatus,
  FindingSeverity,
  JsonValue,
  PilotCoverageEntry,
  PilotFinding,
  PilotRelationship,
  PilotResource,
  PilotSnapshotPayload,
} from "./pilot-types.ts";
import { canonicalJson } from "./canonical-json.ts";
import { isExactDeclaredAwsCapabilityPartition } from "./aws-permission-capabilities.ts";

const HASH = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/#+=-]*$/u;
const REGION = /^(?:global|[a-z]{2}(?:-gov)?-[a-z]+-\d)$/u;
const RESOURCE_LIMIT = 10_000;
const RELATIONSHIP_LIMIT = 20_000;
const FINDING_LIMIT = 5_000;
const COVERAGE_LIMIT = 500;

export class PilotBoundaryError extends Error {
  public readonly code = "BROKER_RESPONSE_INVALID";

  public constructor() {
    super("The collector returned a response that failed Sutra validation");
    this.name = "PilotBoundaryError";
  }
}

function invalid(): never {
  throw new PilotBoundaryError();
}

function awsAccountId(value: unknown): string {
  try {
    return parseAwsAccountId(value);
  } catch {
    return invalid();
  }
}

function awsPartition(value: unknown): AwsPartition {
  try {
    return parseAwsPartition(value);
  } catch {
    return invalid();
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid();
  return record;
}

function string(value: unknown, maximum: number, pattern?: RegExp): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > maximum ||
    value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value) ||
    (pattern !== undefined && !pattern.test(value))
  ) invalid();
  return value;
}

function optionalString(value: unknown, maximum: number): string | null {
  return value === null ? null : string(value, maximum);
}

function safeCount(value: unknown, maximum = 10_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) invalid();
  return value as number;
}

function date(value: unknown): string {
  const parsed = Date.parse(string(value, 40));
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid();
  if (parsed > Date.now() + 5 * 60_000 || parsed < Date.now() - 24 * 60 * 60_000) invalid();
  return value as string;
}

function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 6) invalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 4_096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) invalid();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) invalid();
    return value.map((item) => jsonValue(item, depth + 1));
  }
  if (typeof value !== "object" || value === null) invalid();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) invalid();
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of entries) {
    if (
      key.length === 0 || key.length > 128 || /[\u0000-\u001f\u007f]/u.test(key) ||
      key === "__proto__" || key === "prototype" || key === "constructor"
    ) invalid();
    result[key] = jsonValue(item, depth + 1);
  }
  return result;
}

function jsonObject(value: unknown): Readonly<Record<string, JsonValue>> {
  const parsed = jsonValue(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid();
  return parsed;
}

function tags(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) invalid();
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (
      key.length === 0 || key.length > 128 || typeof item !== "string" || item.length > 512 ||
      key === "__proto__" || key === "prototype" || key === "constructor"
    ) invalid();
    result[key] = item;
  }
  return result;
}

function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  return value;
}

function parseCoverage(value: unknown): PilotCoverageEntry {
  const record = exactRecordWithOptional(value,
    ["collectorKey", "region", "status", "itemsObserved", "pagesObserved"],
    ["errorCode", "message"],
  );
  const allowed = new Set<CoverageStatus>(["succeeded", "partial", "failed", "skipped"]);
  if (!allowed.has(record.status as CoverageStatus)) invalid();
  return {
    collectorKey: string(record.collectorKey, 96, IDENTIFIER),
    region: string(record.region, 32, REGION),
    status: record.status as CoverageStatus,
    itemsObserved: safeCount(record.itemsObserved, RESOURCE_LIMIT),
    pagesObserved: safeCount(record.pagesObserved, 100_000),
    ...(record.errorCode === undefined ? {} : { errorCode: string(record.errorCode, 64, IDENTIFIER) }),
    ...(record.message === undefined ? {} : { message: string(record.message, 240) }),
  };
}

function exactRecordWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || required.some((key) => !(key in record))) invalid();
  return record;
}

function parseResource(value: unknown, expectedAccountId: string): PilotResource {
  const record = exactRecord(value, [
    "resourceKey", "service", "resourceType", "nativeId", "arn", "name", "region",
    "state", "tags", "configuration", "source", "contentSha256",
  ]);
  const source = exactRecord(record.source, ["api", "accountId", "collectedAt"]);
  const sourceAccount = awsAccountId(source.accountId);
  if (sourceAccount !== expectedAccountId) invalid();
  return {
    resourceKey: string(record.resourceKey, 180, IDENTIFIER),
    service: string(record.service, 64, IDENTIFIER).toLowerCase(),
    resourceType: string(record.resourceType, 128, IDENTIFIER),
    nativeId: string(record.nativeId, 512),
    arn: optionalString(record.arn, 2_048),
    name: optionalString(record.name, 512),
    region: string(record.region, 32, REGION),
    state: string(record.state, 64, IDENTIFIER).toLowerCase(),
    tags: tags(record.tags),
    configuration: jsonObject(record.configuration),
    source: {
      api: string(source.api, 128, IDENTIFIER),
      accountId: sourceAccount,
      collectedAt: date(source.collectedAt),
    },
    contentSha256: string(record.contentSha256, 64, HASH),
  };
}

function parseRelationship(value: unknown): PilotRelationship {
  const record = exactRecord(value, ["fromResourceKey", "toResourceKey", "relationType", "evidence"]);
  return {
    fromResourceKey: string(record.fromResourceKey, 180, IDENTIFIER),
    toResourceKey: string(record.toResourceKey, 180, IDENTIFIER),
    relationType: string(record.relationType, 96, IDENTIFIER),
    evidence: jsonObject(record.evidence),
  };
}

function parseFinding(value: unknown): PilotFinding {
  const record = exactRecord(value, [
    "fingerprint", "resourceKey", "controlKey", "controlVersion", "severity", "status",
    "title", "summary", "remediation", "evidence", "evaluatedAt",
  ]);
  const severities = new Set<FindingSeverity>(["critical", "high", "medium", "low", "informational"]);
  if (!severities.has(record.severity as FindingSeverity)) invalid();
  if (!["open", "acknowledged", "resolved", "suppressed"].includes(record.status as string)) invalid();
  return {
    fingerprint: string(record.fingerprint, 128, IDENTIFIER),
    resourceKey: record.resourceKey === null ? null : string(record.resourceKey, 180, IDENTIFIER),
    controlKey: string(record.controlKey, 96, IDENTIFIER),
    controlVersion: string(record.controlVersion, 32, IDENTIFIER),
    severity: record.severity as FindingSeverity,
    status: record.status as PilotFinding["status"],
    title: string(record.title, 180),
    summary: string(record.summary, 1_200),
    remediation: string(record.remediation, 2_000),
    evidence: jsonObject(record.evidence),
    evaluatedAt: date(record.evaluatedAt),
  };
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

export function snapshotHashInput(payload: Omit<PilotSnapshotPayload, "snapshotSha256">): string {
  return canonicalJson({
    schemaVersion: payload.schemaVersion,
    jobId: payload.jobId,
    connectionId: payload.connectionId,
    accountId: payload.accountId,
    partition: payload.partition,
    roleSessionName: payload.roleSessionName,
    collectedAt: payload.collectedAt,
    coverageState: payload.coverageState,
    coverage: payload.coverage,
    resources: payload.resources,
    relationships: payload.relationships,
    findings: payload.findings,
  });
}

export async function computeSnapshotSha256(
  payload: Omit<PilotSnapshotPayload, "snapshotSha256">,
): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshotHashInput(payload))));
}

export async function parsePilotSnapshot(
  value: unknown,
  expected: { readonly jobId: string; readonly connectionId: string; readonly accountId: string; readonly partition: AwsPartition },
): Promise<PilotSnapshotPayload> {
  const record = exactRecord(value, [
    "schemaVersion", "jobId", "connectionId", "accountId", "partition", "roleSessionName",
    "collectedAt", "coverageState", "coverage", "resources", "relationships", "findings", "snapshotSha256",
  ]);
  if (record.schemaVersion !== "sutra.inventory.v1") invalid();
  const jobId = string(record.jobId, 128, IDENTIFIER);
  const connectionId = string(record.connectionId, 128, IDENTIFIER);
  const accountId = awsAccountId(record.accountId);
  const parsedPartition = awsPartition(record.partition);
  if (
    jobId !== expected.jobId || connectionId !== expected.connectionId || accountId !== expected.accountId ||
    parsedPartition !== expected.partition
  ) invalid();
  if (record.coverageState !== "complete" && record.coverageState !== "partial") invalid();
  const coverage = array(record.coverage, COVERAGE_LIMIT).map(parseCoverage);
  if (coverage.length === 0) invalid();
  const resources = array(record.resources, RESOURCE_LIMIT).map((item) => parseResource(item, accountId));
  const relationships = array(record.relationships, RELATIONSHIP_LIMIT).map(parseRelationship);
  const findings = array(record.findings, FINDING_LIMIT).map(parseFinding);

  const resourceKeys = new Set<string>();
  for (const resource of resources) {
    if (resourceKeys.has(resource.resourceKey)) invalid();
    resourceKeys.add(resource.resourceKey);
  }
  const relationshipKeys = new Set<string>();
  for (const relationship of relationships) {
    if (!resourceKeys.has(relationship.fromResourceKey) || !resourceKeys.has(relationship.toResourceKey)) invalid();
    const key = `${relationship.fromResourceKey}\n${relationship.toResourceKey}\n${relationship.relationType}`;
    if (relationshipKeys.has(key)) invalid();
    relationshipKeys.add(key);
  }
  const findingKeys = new Set<string>();
  for (const finding of findings) {
    if (finding.resourceKey !== null && !resourceKeys.has(finding.resourceKey)) invalid();
    if (findingKeys.has(finding.fingerprint)) invalid();
    findingKeys.add(finding.fingerprint);
  }
  if (record.coverageState === "complete" && coverage.some((item) => item.status !== "succeeded")) invalid();

  const unsigned: Omit<PilotSnapshotPayload, "snapshotSha256"> = {
    schemaVersion: "sutra.inventory.v1",
    jobId,
    connectionId,
    accountId,
    partition: parsedPartition,
    roleSessionName: string(record.roleSessionName, 64, IDENTIFIER),
    collectedAt: date(record.collectedAt),
    coverageState: record.coverageState,
    coverage,
    resources,
    relationships,
    findings,
  };
  const snapshotSha256 = string(record.snapshotSha256, 64, HASH);
  if (await computeSnapshotSha256(unsigned) !== snapshotSha256) invalid();
  return { ...unsigned, snapshotSha256 };
}

export function parseCollectorHealth(value: unknown, expectedPartition?: AwsPartition): CollectorHealth {
  const record = exactRecord(value, ["ok", "mode", "version", "principalArn", "sourceAccountId", "message"]);
  if (typeof record.ok !== "boolean" || (record.mode !== "fixture" && record.mode !== "live")) invalid();
  const principalArn = record.principalArn === null ? null : string(record.principalArn, 620);
  const sourceAccountId = record.sourceAccountId === null ? null : awsAccountId(record.sourceAccountId);
  if ((principalArn === null) !== (sourceAccountId === null)) invalid();
  if (principalArn !== null) {
    let parsed;
    try {
      parsed = parseIamRoleArn(principalArn);
    } catch {
      return invalid();
    }
    if (parsed.accountId !== sourceAccountId || (expectedPartition !== undefined && parsed.partition !== expectedPartition)) invalid();
  }
  return {
    ok: record.ok,
    mode: record.mode,
    version: string(record.version, 32, IDENTIFIER),
    principalArn,
    sourceAccountId,
    message: string(record.message, 240),
  };
}

export function parseRegisteredResponse(value: unknown): { readonly registered: true } {
  const record = exactRecord(value, ["registered"]);
  if (record.registered !== true) invalid();
  return { registered: true };
}

export function parseVerificationResponse(
  value: unknown,
  expected: {
    readonly accountId: string;
    readonly partition: AwsPartition;
    readonly roleArn: string;
    readonly sessionNamePrefix: string;
  },
): {
  readonly verified: true;
  readonly accountId: string;
  readonly roleArn: string;
  readonly roleSessionName: string;
  readonly callerIdentityArn: string;
  readonly missingExternalIdDenied: true;
  readonly wrongExternalIdDenied: true;
  readonly trustPolicyAttested: true;
  readonly permissionPolicyAttested: true;
  readonly sessionPolicyApplied: true;
  readonly permissionPackVersion: "standard-2026-07.4";
  readonly capabilityAssessment: AwsPermissionCapabilityAssessment;
} {
  const record = exactRecord(value, [
    "verified", "accountId", "roleArn", "roleSessionName", "callerIdentityArn", "missingExternalIdDenied", "wrongExternalIdDenied",
    "trustPolicyAttested", "permissionPolicyAttested", "sessionPolicyApplied", "permissionPackVersion",
    "capabilityAssessment",
  ]);
  if (
    record.verified !== true ||
    record.missingExternalIdDenied !== true ||
    record.wrongExternalIdDenied !== true ||
    record.trustPolicyAttested !== true ||
    record.permissionPolicyAttested !== true ||
    record.sessionPolicyApplied !== true ||
    record.permissionPackVersion !== "standard-2026-07.4"
  ) invalid();
  const accountId = awsAccountId(record.accountId);
  const roleArn = string(record.roleArn, 2_048);
  const roleSessionName = string(record.roleSessionName, 64);
  const arn = string(record.callerIdentityArn, 2_048);
  let expectedRole;
  try {
    expectedRole = parseIamRoleArn(expected.roleArn, expected);
  } catch {
    return invalid();
  }
  const match = /^arn:(aws|aws-us-gov|aws-cn):sts::(\d{12}):assumed-role\/([A-Za-z0-9_+=,.@-]{1,64})\/([A-Za-z0-9_+=,.@-]{2,64})$/u.exec(arn);
  if (
    !match ||
    accountId !== expected.accountId ||
    roleArn !== expectedRole.arn ||
    !/^[A-Za-z0-9_+=,.@-]{3,32}$/u.test(expected.sessionNamePrefix) ||
    !/^[A-Za-z0-9_+=,.@-]{2,64}$/u.test(roleSessionName) ||
    !roleSessionName.startsWith(expected.sessionNamePrefix) ||
    match[1] !== expected.partition ||
    match[2] !== expected.accountId ||
    match[3] !== expectedRole.roleName ||
    match[4] !== roleSessionName
  ) invalid();
  const capabilityRecord = exactRecord(record.capabilityAssessment, ["grantedActions", "missingActions"]);
  const capabilityList = (value: unknown): readonly string[] => {
    if (
      !Array.isArray(value) ||
      value.length > 256 ||
      !value.every((action) => typeof action === "string" && /^[a-z0-9-]+:[A-Za-z0-9*]+$/u.test(action)) ||
      new Set(value).size !== value.length
    ) invalid();
    return value as string[];
  };
  const grantedActions = capabilityList(capabilityRecord.grantedActions);
  const missingActions = capabilityList(capabilityRecord.missingActions);
  if (!isExactDeclaredAwsCapabilityPartition(grantedActions, missingActions)) invalid();
  return {
    verified: true,
    accountId,
    roleArn,
    roleSessionName,
    callerIdentityArn: arn,
    missingExternalIdDenied: true,
    wrongExternalIdDenied: true,
    trustPolicyAttested: true,
    permissionPolicyAttested: true,
    sessionPolicyApplied: true,
    permissionPackVersion: "standard-2026-07.4",
    capabilityAssessment: { grantedActions, missingActions },
  };
}

/**
 * Exact-shape verification proof for a static-credential connection. The
 * collector never returns the credentials themselves; the only credential
 * derivative accepted here is the last four characters of the access key ID.
 */
export function parseStaticCredentialVerificationResponse(
  value: unknown,
  expected: {
    readonly accountId: string;
    readonly partition: AwsPartition;
  },
): {
  readonly verified: true;
  readonly credentialKind: "static_credentials";
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly callerIdentityArn: string;
  readonly accessKeyLast4: string;
} {
  const record = exactRecord(value, [
    "verified", "credentialKind", "accountId", "partition", "callerIdentityArn", "accessKeyLast4",
  ]);
  if (record.verified !== true || record.credentialKind !== "static_credentials") invalid();
  const accountId = awsAccountId(record.accountId);
  const partition = awsPartition(record.partition);
  const callerIdentityArn = string(record.callerIdentityArn, 2_048);
  const accessKeyLast4 = string(record.accessKeyLast4, 4, /^[A-Z0-9]{4}$/u);
  if (
    accountId !== expected.accountId ||
    partition !== expected.partition ||
    !new RegExp(
      `^arn:${partition}:(?:iam|sts)::${accountId}:[A-Za-z0-9_+=,.@/-]{1,512}$`,
      "u",
    ).test(callerIdentityArn)
  ) invalid();
  return {
    verified: true,
    credentialKind: "static_credentials",
    accountId,
    partition,
    callerIdentityArn,
    accessKeyLast4,
  };
}
