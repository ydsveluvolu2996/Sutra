/**
 * Security boundary helpers for the local AWS onboarding pilot.
 *
 * This module is runtime-neutral: it uses Web Crypto so the same validation and
 * secret-protection rules can run in Cloudflare Workers and Node tests. It does
 * not import the AWS collector and never accepts AWS credentials from callers.
 */

import {
  ALL_ENABLED_AWS_REGIONS,
  type AwsRegionSelection,
} from "./aws-region-selection.ts";
import { effectiveRequestOrigin } from "./request-origin.ts";

export type AwsPartition = "aws" | "aws-us-gov" | "aws-cn";
export type AwsRoleProvisioningMode = "sutra_template" | "customer_managed";
export type AwsConnectionMethod = "trust_role" | "static_credentials";

export const SUTRA_ROLE_PATH = "/sutra/" as const;
export const SUTRA_TEMPLATE_ROLE_NAME = "SutraCollectorRole" as const;
/** Pre-2026-07-28 name. Still valid: renaming a deployed role changes its ARN. */
export const SUTRA_TEMPLATE_ROLE_NAME_LEGACY = "SutraReadOnlyRole" as const;
export const SUTRA_TEMPLATE_ROLE_NAMES: readonly string[] = [
  SUTRA_TEMPLATE_ROLE_NAME,
  SUTRA_TEMPLATE_ROLE_NAME_LEGACY,
];

export type PilotConnectionStatus =
  | "pending"
  | "validating"
  | "active"
  | "needs_attention"
  | "disabled";

export type PilotSyncStatus =
  | "queued"
  | "running"
  | "partial"
  | "succeeded"
  | "failed"
  | "cancelled";

export type SafePilotFailureCode =
  | "ASSUME_ROLE_DENIED"
  | "ASSUME_ROLE_FAILED"
  | "BROKER_UNAVAILABLE"
  | "CALLER_IDENTITY_MISMATCH"
  | "COLLECTION_FAILED"
  | "COLLECTION_PARTIAL"
  | "NEGATIVE_PROBE_INCONCLUSIVE"
  | "PERMISSION_DENIED"
  | "THROTTLED"
  | "TRUST_POLICY_UNSAFE"
  | "VALIDATION_FAILED";

export interface OffboardConnectionRequest {
  readonly connectionId: string;
  readonly awsAccountId: string;
}

export type PilotSecurityErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STATE"
  | "SECRET_UNAVAILABLE";

export class PilotSecurityError extends Error {
  public readonly code: PilotSecurityErrorCode;

  public constructor(code: PilotSecurityErrorCode, message: string) {
    super(message);
    this.name = "PilotSecurityError";
    this.code = code;
  }
}

export interface PilotScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly actorId: string;
}

export interface ParsedIamRoleArn {
  readonly arn: string;
  readonly partition: AwsPartition;
  readonly accountId: string;
  readonly rolePathAndName: string;
  readonly roleName: string;
}

export interface ExpectedIamRoleBinding {
  readonly accountId: string;
  readonly partition: AwsPartition;
}

export interface AwsOnboardingInput {
  readonly awsAccountId: string;
  readonly partition: AwsPartition;
  readonly roleArn: string;
  readonly enabledRegions: AwsRegionSelection;
}

/**
 * Browser input for the first, recoverable trust handoff. The operation ID is
 * an opaque retry key only; account/customer scope and the ExternalId remain
 * server controlled.
 */
export interface AwsConnectionDraftRequest {
  readonly operationId: string;
  readonly customerName: string;
  readonly awsAccountId: string;
  readonly partition: AwsPartition;
  readonly enabledRegions: AwsRegionSelection;
  readonly roleProvisioningMode: AwsRoleProvisioningMode;
  readonly rolePath: string;
  readonly roleName: string;
  readonly connectionMethod: AwsConnectionMethod;
}

/**
 * Browser input for the one-request static credential submission. Credentials
 * are validated for shape only and are NEVER stored, logged, or echoed back;
 * they pass through a single request to the collector broker.
 */
export interface AwsStaticCredentialsSubmission {
  readonly connectionId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface LocalAwsConnectionIdentity {
  readonly customerId: string;
  readonly connectionId: string;
}

const LOCAL_PILOT_ORG_ID = "org_local_sutra";
const TENANT_SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface PilotSyncRequest {
  readonly connectionId: string;
  readonly idempotencyKey: string;
}

export type PilotSyncCoverage = "complete" | "partial";

export interface PilotSyncSummary {
  readonly coverage: PilotSyncCoverage;
  readonly resourcesObserved: number;
  readonly findingsObserved: number;
}

export interface SafePilotFailure {
  readonly code: SafePilotFailureCode;
}

export interface SecretContext {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface EncryptedSecret {
  readonly ciphertext: string;
  readonly keyVersion: string;
}

interface CryptoProvider {
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const ACCOUNT_ID = /^\d{12}$/;
const ROLE_COMPONENTS = /^[A-Za-z0-9+=,.@_/-]+$/;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const ONBOARDING_OPERATION_ID = /^onb_[a-f0-9]{32}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const AES_GCM_FORMAT = "aesgcm1";
const EXTERNAL_ID_BYTES = 24;
const MAX_ENABLED_REGIONS = 32;
const MAX_SAFE_COUNT = 10_000_000;
export const DEFAULT_JSON_BODY_LIMIT = 16 * 1024;
/**
 * Ceiling on the per-caller limit, not a per-caller limit itself: each route still
 * passes its own (usually far smaller) bound, and omitting one keeps the 16 KiB
 * default. The value is 3 MiB because readBoundedJson buffers the whole body in
 * memory and the largest legitimate caller is the Kubernetes scan publication
 * route, whose artifacts embed Trivy findings and SBOMs; its browser upload path
 * gates files at 2.75 MiB and its agent-facing sibling already streams 10 MiB
 * through readAgentJson. Raise this only for a caller that genuinely needs more —
 * bulk ingestion belongs on the agent/CLI paths, not on a session-authenticated
 * JSON endpoint.
 */
export const MAX_CONFIGURABLE_JSON_BODY_LIMIT = 3 * 1024 * 1024;

const PARTITIONS = new Set<AwsPartition>(["aws", "aws-us-gov", "aws-cn"]);
const FAILURE_CODES = new Set<SafePilotFailureCode>([
  "ASSUME_ROLE_DENIED",
  "ASSUME_ROLE_FAILED",
  "BROKER_UNAVAILABLE",
  "CALLER_IDENTITY_MISMATCH",
  "COLLECTION_FAILED",
  "COLLECTION_PARTIAL",
  "NEGATIVE_PROBE_INCONCLUSIVE",
  "PERMISSION_DENIED",
  "THROTTLED",
  "TRUST_POLICY_UNSAFE",
  "VALIDATION_FAILED",
]);

const CONNECTION_TRANSITIONS: Readonly<Record<PilotConnectionStatus, ReadonlySet<PilotConnectionStatus>>> = {
  pending: new Set(["validating", "disabled"]),
  validating: new Set(["active", "needs_attention", "disabled"]),
  active: new Set(["pending", "validating", "needs_attention", "disabled"]),
  needs_attention: new Set(["pending", "validating", "disabled"]),
  disabled: new Set(),
};

const SYNC_TRANSITIONS: Readonly<Record<PilotSyncStatus, ReadonlySet<PilotSyncStatus>>> = {
  queued: new Set(["running", "failed", "cancelled"]),
  running: new Set(["partial", "succeeded", "failed", "cancelled"]),
  partial: new Set(),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

/** Parses trusted server context. Browser-supplied scope must never be passed here. */
export function parsePilotScope(value: unknown): PilotScope {
  const record = exactRecord(value, ["orgId", "customerId", "actorId"]);
  return {
    orgId: requiredIdentifier(record.orgId),
    customerId: requiredIdentifier(record.customerId),
    actorId: requiredIdentifier(record.actorId),
  };
}

/**
 * Parses the only fields accepted from an onboarding request. In particular,
 * ExternalId, tenant/customer scope, credentials, permission policy, and status
 * are deliberately not accepted from the caller.
 */
export function parseAwsOnboardingInput(value: unknown): AwsOnboardingInput {
  const record = exactRecord(value, [
    "awsAccountId",
    "partition",
    "roleArn",
    "enabledRegions",
  ]);

  const awsAccountId = parseAwsAccountId(record.awsAccountId);
  const partition = parseAwsPartition(record.partition);
  if (typeof record.roleArn !== "string") {
    invalidInput();
  }

  const role = parseIamRoleArn(record.roleArn, { accountId: awsAccountId, partition });

  const enabledRegions = parseRegions(record.enabledRegions, partition);
  return { awsAccountId, partition, roleArn: role.arn, enabledRegions };
}

/**
 * Strict boundary for the initial connection route. A client-generated retry
 * key makes a committed response recoverable without accepting client scope,
 * trust material, role policy, credentials, or lifecycle state.
 */
export function parseAwsConnectionDraftRequest(value: unknown): AwsConnectionDraftRequest {
  const candidate = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const hasRoleContract = candidate !== null && ["roleProvisioningMode", "rolePath", "roleName"]
    .some((key) => Object.hasOwn(candidate, key));
  const hasConnectionMethod = candidate !== null && Object.hasOwn(candidate, "connectionMethod");
  const record = exactRecord(value, [
    "operationId",
    "customerName",
    "awsAccountId",
    "partition",
    "enabledRegions",
    ...(hasRoleContract ? ["roleProvisioningMode", "rolePath", "roleName"] : []),
    ...(hasConnectionMethod ? ["connectionMethod"] : []),
  ]);
  const connectionMethod = record.connectionMethod === undefined
    ? "trust_role"
    : record.connectionMethod;
  if (connectionMethod !== "trust_role" && connectionMethod !== "static_credentials") {
    invalidInput("Choose a supported AWS connection method");
  }
  if (connectionMethod === "static_credentials" && hasRoleContract) {
    // Static-credential connections have no IAM role contract; accepting role
    // keys here would silently persist an unusable trust configuration.
    invalidInput("Static credential connections do not accept an IAM role contract");
  }
  if (
    typeof record.operationId !== "string" ||
    !ONBOARDING_OPERATION_ID.test(record.operationId)
  ) {
    invalidInput("The onboarding retry identifier is invalid");
  }
  if (typeof record.customerName !== "string") {
    invalidInput("Enter a customer name");
  }
  const customerName = record.customerName.trim().replace(/\s+/gu, " ");
  if (
    customerName.length < 2 ||
    customerName.length > 80 ||
    /[<>\u0000-\u001f]/u.test(customerName)
  ) {
    invalidInput("Enter a customer name between 2 and 80 characters");
  }
  const awsAccountId = parseAwsAccountId(record.awsAccountId);
  const partition = parseAwsPartition(record.partition);
  const enabledRegions = parseRegions(record.enabledRegions, partition);
  if (enabledRegions.length === 0) {
    invalidInput("Choose at least one AWS region");
  }
  const roleProvisioningMode = record.roleProvisioningMode === undefined
    ? "sutra_template"
    : record.roleProvisioningMode;
  if (roleProvisioningMode !== "sutra_template" && roleProvisioningMode !== "customer_managed") {
    invalidInput("Choose a supported IAM role provisioning mode");
  }
  const rolePath = record.rolePath === undefined ? SUTRA_ROLE_PATH : record.rolePath;
  const roleName = record.roleName === undefined ? SUTRA_TEMPLATE_ROLE_NAME : record.roleName;
  if (typeof rolePath !== "string" || typeof roleName !== "string") {
    invalidInput("The dedicated IAM role path and name are required");
  }
  if (roleProvisioningMode === "sutra_template") {
    if (rolePath !== SUTRA_ROLE_PATH || roleName !== SUTRA_TEMPLATE_ROLE_NAME) {
      invalidInput("The Sutra template uses the reviewed /sutra/SutraCollectorRole contract (the legacy SutraReadOnlyRole name is also accepted)");
    }
  } else {
    if (
      rolePath.length > 512 ||
      !/^\/sutra\/(?:[A-Za-z0-9+=,.@_-]+\/)*$/u.test(rolePath)
    ) {
      invalidInput("Customer-managed roles must use a dedicated path inside /sutra/");
    }
    if (!/^[A-Za-z0-9+=,.@_-]{1,64}$/u.test(roleName)) {
      invalidInput("Enter a valid dedicated IAM role name between 1 and 64 characters");
    }
    const loweredRoleName = roleName.toLowerCase();
    if (
      /(admin|poweruser|root|shared|operation|break[-_.]?glass)/u.test(loweredRoleName) ||
      loweredRoleName === "organizationaccountaccessrole"
    ) {
      invalidInput("Admin, shared, root, power-user, and operational IAM roles cannot be onboarded");
    }
  }
  return {
    operationId: record.operationId,
    customerName,
    awsAccountId,
    partition,
    enabledRegions,
    roleProvisioningMode,
    rolePath,
    roleName,
    connectionMethod,
  };
}

const STATIC_ACCESS_KEY_ID = /^AKIA[A-Z0-9]{16}$/u;
const STATIC_SECRET_ACCESS_KEY = /^[A-Za-z0-9/+]{40}$/u;

/**
 * Strict boundary for the one-request static credential submission. Exact keys
 * only. Persistent onboarding accepts a long-lived key from a dedicated IAM
 * user; temporary session credentials are deliberately rejected because their
 * expiry cannot be made durable. Error messages never echo submitted material.
 */
export function parseAwsStaticCredentialsSubmission(
  value: unknown,
): AwsStaticCredentialsSubmission {
  const record = exactRecord(value, [
    "connectionId",
    "accessKeyId",
    "secretAccessKey",
  ]);
  if (typeof record.connectionId !== "string" || !/^conn_[a-f0-9]{32}$/u.test(record.connectionId)) {
    invalidInput("The connection identifier is invalid");
  }
  if (typeof record.accessKeyId !== "string" || !STATIC_ACCESS_KEY_ID.test(record.accessKeyId)) {
    invalidInput("Enter a valid AWS access key ID");
  }
  if (typeof record.secretAccessKey !== "string" || !STATIC_SECRET_ACCESS_KEY.test(record.secretAccessKey)) {
    invalidInput("Enter a valid AWS secret access key");
  }
  return {
    connectionId: record.connectionId,
    accessKeyId: record.accessKeyId,
    secretAccessKey: record.secretAccessKey,
  };
}

/**
 * The local pilot deliberately has one durable customer/connection identity
 * for an AWS account. Stable IDs turn concurrent first-create requests into a
 * database primary-key race instead of duplicate connections.
 */
export async function deriveLocalAwsConnectionIdentity(
  accountIdValue: unknown,
  partitionValue: unknown,
): Promise<LocalAwsConnectionIdentity> {
  const accountId = parseAwsAccountId(accountIdValue);
  const partition = parseAwsPartition(partitionValue);
  const digest = async (domain: string): Promise<string> => {
    const bytes = new TextEncoder().encode(`${domain}\u0000${partition}\u0000${accountId}`);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
  };
  return {
    customerId: `cust_${await digest("sutra-local-customer-v1")}`,
    connectionId: `conn_${await digest("sutra-local-aws-connection-v1")}`,
  };
}

/**
 * Derive stable connection identities inside an authenticated organization.
 *
 * Local identities intentionally retain their original byte-for-byte
 * derivation so existing fixture and pilot data remains addressable. Hosted
 * identities bind the organization into both domains, preventing the same AWS
 * account in two Sutra tenants from sharing a customer or connection primary
 * key.
 */
export async function deriveScopedAwsConnectionIdentity(
  orgIdValue: unknown,
  accountIdValue: unknown,
  partitionValue: unknown,
): Promise<LocalAwsConnectionIdentity> {
  if (typeof orgIdValue !== "string" || !TENANT_SCOPE_ID.test(orgIdValue)) {
    throw new PilotSecurityError("INVALID_INPUT", "The organization scope is invalid");
  }
  if (orgIdValue === LOCAL_PILOT_ORG_ID) {
    return deriveLocalAwsConnectionIdentity(accountIdValue, partitionValue);
  }
  const accountId = parseAwsAccountId(accountIdValue);
  const partition = parseAwsPartition(partitionValue);
  const digest = async (domain: string): Promise<string> => {
    const bytes = new TextEncoder().encode(
      `${domain}\u0000${orgIdValue}\u0000${partition}\u0000${accountId}`,
    );
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
  };
  return {
    customerId: `cust_${await digest("sutra-hosted-customer-v1")}`,
    connectionId: `conn_${await digest("sutra-hosted-aws-connection-v1")}`,
  };
}

export function parseAwsAccountId(value: unknown): string {
  return requiredAccountId(value);
}

/** Requires a second server-checked account identifier for destructive offboarding. */
export function parseOffboardConnectionRequest(value: unknown): OffboardConnectionRequest {
  const record = exactRecord(value, ["connectionId", "awsAccountId"]);
  if (
    typeof record.connectionId !== "string" ||
    !/^conn_[a-f0-9]{32}$/u.test(record.connectionId)
  ) {
    invalidInput("The offboarding request is invalid");
  }
  return {
    connectionId: record.connectionId,
    awsAccountId: parseAwsAccountId(record.awsAccountId),
  };
}

export function assertOffboardAccountConfirmation(
  providedAccountId: string,
  expectedAccountId: string,
): void {
  const provided = parseAwsAccountId(providedAccountId);
  const expected = parseAwsAccountId(expectedAccountId);
  if (provided !== expected) {
    invalidInput("The AWS account confirmation does not match");
  }
}

export function parseAwsPartition(value: unknown): AwsPartition {
  return requiredPartition(value);
}

export function parseIamRoleArn(
  value: unknown,
  expected?: ExpectedIamRoleBinding,
): ParsedIamRoleArn {
  if (typeof value !== "string" || value.length > 620 || value.trim() !== value) {
    invalidInput("The IAM role ARN is invalid");
  }

  const match = /^arn:(aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/(.+)$/.exec(value);
  if (!match) {
    invalidInput("The IAM role ARN is invalid");
  }

  const partition = requiredPartition(match[1]);
  const accountId = requiredAccountId(match[2]);
  const rolePathAndName = match[3];

  if (
    rolePathAndName.length > 512 ||
    rolePathAndName.startsWith("/") ||
    rolePathAndName.endsWith("/") ||
    !ROLE_COMPONENTS.test(rolePathAndName)
  ) {
    invalidInput("The IAM role ARN is invalid");
  }

  const segments = rolePathAndName.split("/");
  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    invalidInput("The IAM role ARN is invalid");
  }

  const roleName = segments.at(-1);
  if (!roleName || roleName.length > 64) {
    invalidInput("The IAM role ARN is invalid");
  }

  if (expected) {
    const expectedAccountId = parseAwsAccountId(expected.accountId);
    const expectedPartition = parseAwsPartition(expected.partition);
    if (accountId !== expectedAccountId || partition !== expectedPartition) {
      invalidInput("The role ARN does not match the registered AWS account and partition");
    }
  }

  return { arn: value, partition, accountId, rolePathAndName, roleName };
}

export function parseRegions(value: unknown, partition: AwsPartition): readonly string[] {
  return parseEnabledRegions(value, parseAwsPartition(partition));
}

/** Parses an untrusted manual-sync request. Trust material is never a job field. */
export function parsePilotSyncRequest(value: unknown): PilotSyncRequest {
  const record = exactRecord(value, ["connectionId", "idempotencyKey"]);
  const connectionId = requiredIdentifier(record.connectionId);
  if (
    typeof record.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY.test(record.idempotencyKey)
  ) {
    invalidInput("The sync idempotency key is invalid");
  }
  return { connectionId, idempotencyKey: record.idempotencyKey };
}

/** Accepts a bounded, allowlisted summary; raw provider errors are not persisted. */
export function parsePilotSyncSummary(value: unknown): PilotSyncSummary {
  const record = exactRecord(value, [
    "coverage",
    "resourcesObserved",
    "findingsObserved",
  ]);
  if (record.coverage !== "complete" && record.coverage !== "partial") {
    invalidInput("The sync coverage value is invalid");
  }
  return {
    coverage: record.coverage,
    resourcesObserved: requiredSafeCount(record.resourcesObserved),
    findingsObserved: requiredSafeCount(record.findingsObserved),
  };
}

/**
 * Only a stable error code may cross into persistence. Messages, stacks, request
 * objects, and AWS SDK errors are intentionally rejected as unknown fields.
 */
export function parseSafePilotFailure(value: unknown): SafePilotFailure {
  const record = exactRecord(value, ["code"]);
  if (typeof record.code !== "string" || !FAILURE_CODES.has(record.code as SafePilotFailureCode)) {
    invalidInput("The failure code is invalid");
  }
  return { code: record.code as SafePilotFailureCode };
}

export function assertConnectionTransition(
  from: PilotConnectionStatus,
  to: PilotConnectionStatus,
): void {
  if (!CONNECTION_TRANSITIONS[from]?.has(to)) {
    invalidState("The AWS connection state transition is not allowed");
  }
}

export function assertSyncTransition(from: PilotSyncStatus, to: PilotSyncStatus): void {
  if (!SYNC_TRANSITIONS[from]?.has(to)) {
    invalidState("The sync state transition is not allowed");
  }
}

/** Partial, failed, cancelled, or unknown runs must never retire unseen resources. */
export function mayRetireUnseenResources(
  status: PilotSyncStatus,
  coverage: PilotSyncCoverage | "unknown",
): boolean {
  return status === "succeeded" && coverage === "complete";
}

/** Only a complete successful run advances the connection freshness timestamp. */
export function mayAdvanceSuccessfulSync(
  status: PilotSyncStatus,
  coverage: PilotSyncCoverage | "unknown",
): boolean {
  return status === "succeeded" && coverage === "complete";
}

/** Generates 192 bits of server-side randomness. The caller must display it once. */
export function generateExternalId(provider: CryptoProvider = globalThis.crypto): string {
  const bytes = provider.getRandomValues(new Uint8Array(EXTERNAL_ID_BYTES));
  return `sutra_${encodeBase64Url(bytes)}`;
}

/** Convenience API for a local pilot configured with one base64 AES-256 key. */
export async function encryptExternalId(
  externalId: string,
  base64Key: string,
  keyVersion: string,
  context: SecretContext,
): Promise<EncryptedSecret> {
  const keyring = await AesGcmSecretKeyring.fromRawKeys({
    currentKeyVersion: keyVersion,
    keys: { [keyVersion]: decodeConfiguredAesKey(base64Key) },
  });
  return keyring.seal(externalId, context);
}

/** Convenience API for decrypting one D1 record with its stored key version. */
export async function decryptExternalId(
  secret: EncryptedSecret,
  base64Key: string,
  context: SecretContext,
): Promise<string> {
  const keyring = await AesGcmSecretKeyring.fromRawKeys({
    currentKeyVersion: secret.keyVersion,
    keys: { [secret.keyVersion]: decodeConfiguredAesKey(base64Key) },
  });
  return keyring.open(secret, context);
}

/**
 * CSRF boundary for browser mutations. Call this before reading or parsing a body.
 * A missing Origin is rejected; non-browser service calls need a separate signed
 * authentication path instead of bypassing this check.
 */
export function assertSameOrigin(request: Request, configuredOrigin?: string): void {
  // The derived origin is only needed when nothing was configured. Requiring it
  // unconditionally is what kept this failing: under wrangler 4.114 / miniflare
  // 4.20260722 the request cannot be made to yield the public origin — Host is
  // rewritten to the listening socket, and a Host carrying an explicit :443 does not
  // survive a URL round-trip because the default port is normalized away, so the
  // derivation returns null and threw here BEFORE the configured value was ever
  // compared. When we have been told the canonical origin, that is the authority and
  // whatever the runtime reconstructs is irrelevant.
  let expectedOrigin: string;
  if (configuredOrigin === undefined) {
    const effectiveOrigin = effectiveRequestOrigin(request);
    if (effectiveOrigin === null) invalidInput("The request origin is invalid");
    expectedOrigin = canonicalOrigin(effectiveOrigin);
  } else {
    expectedOrigin = canonicalOrigin(configuredOrigin);
  }
  const suppliedOrigin = request.headers.get("origin");
  if (suppliedOrigin === null || suppliedOriginCanonical(request, suppliedOrigin) !== expectedOrigin) {
    invalidInput("The request origin is invalid");
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") {
    invalidInput("The request origin is invalid");
  }
}

/** Reads JSON incrementally so a false or omitted Content-Length cannot bypass caps. */
export async function readBoundedJson(
  request: Request,
  maximumBytes = DEFAULT_JSON_BODY_LIMIT,
): Promise<unknown> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_CONFIGURABLE_JSON_BODY_LIMIT
  ) {
    invalidInput("The JSON body limit is invalid");
  }

  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    invalidInput("The request content type is invalid");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes) {
      invalidInput("The JSON request body is too large");
    }
  }
  if (request.body === null) {
    invalidInput("The JSON request body is missing");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        invalidInput("The JSON request body is too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) {
    invalidInput("The JSON request body is missing");
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(combined);
    return JSON.parse(text) as unknown;
  } catch {
    invalidInput("The JSON request body is invalid");
  }
}

/**
 * Small AES-256-GCM keyring for encrypting the ExternalId before D1 persistence.
 * Associated data binds ciphertext to its organization, customer, and connection;
 * copying it to another tenant or record therefore fails authentication.
 */
export class AesGcmSecretKeyring {
  private readonly keys: ReadonlyMap<string, CryptoKey>;
  public readonly currentKeyVersion: string;
  private readonly provider: CryptoProvider;

  private constructor(
    keys: ReadonlyMap<string, CryptoKey>,
    currentKeyVersion: string,
    provider: CryptoProvider,
  ) {
    this.keys = keys;
    this.currentKeyVersion = currentKeyVersion;
    this.provider = provider;
  }

  public static async fromRawKeys(options: {
    readonly currentKeyVersion: string;
    readonly keys: Readonly<Record<string, Uint8Array>>;
    readonly provider?: CryptoProvider;
  }): Promise<AesGcmSecretKeyring> {
    const provider = options.provider ?? globalThis.crypto;
    if (!KEY_VERSION.test(options.currentKeyVersion)) {
      invalidInput("The secret key version is invalid");
    }

    const imported = new Map<string, CryptoKey>();
    for (const [version, raw] of Object.entries(options.keys)) {
      if (!KEY_VERSION.test(version) || !(raw instanceof Uint8Array) || raw.byteLength !== 32) {
        invalidInput("An AES-GCM key is invalid");
      }
      imported.set(
        version,
        await provider.subtle.importKey("raw", copiedArrayBuffer(raw), { name: "AES-GCM" }, false, [
          "encrypt",
          "decrypt",
        ]),
      );
    }

    if (!imported.has(options.currentKeyVersion)) {
      invalidInput("The current secret key version is unavailable");
    }
    return new AesGcmSecretKeyring(imported, options.currentKeyVersion, provider);
  }

  public async seal(plaintext: string, context: SecretContext): Promise<EncryptedSecret> {
    assertSecretContext(context);
    if (plaintext.length < 20 || plaintext.length > 128) {
      invalidInput("The sensitive value has an invalid length");
    }

    const key = this.keys.get(this.currentKeyVersion);
    if (!key) {
      secretUnavailable();
    }

    const iv = this.provider.getRandomValues(new Uint8Array(12));
    const ciphertext = await this.provider.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: copiedArrayBuffer(iv),
        additionalData: secretAssociatedData(context),
        tagLength: 128,
      },
      key,
      copiedArrayBuffer(new TextEncoder().encode(plaintext)),
    );

    return {
      keyVersion: this.currentKeyVersion,
      ciphertext: `${AES_GCM_FORMAT}.${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(ciphertext))}`,
    };
  }

  public async open(secret: EncryptedSecret, context: SecretContext): Promise<string> {
    assertSecretContext(context);
    if (!KEY_VERSION.test(secret.keyVersion)) {
      secretUnavailable();
    }
    const key = this.keys.get(secret.keyVersion);
    if (!key) {
      secretUnavailable();
    }

    const parts = secret.ciphertext.split(".");
    if (parts.length !== 3 || parts[0] !== AES_GCM_FORMAT) {
      secretUnavailable();
    }

    try {
      const iv = decodeBase64Url(parts[1], 12);
      const ciphertext = decodeBase64Url(parts[2], 16 + 1, 16 + 128);
      const plaintext = await this.provider.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: copiedArrayBuffer(iv),
          additionalData: secretAssociatedData(context),
          tagLength: 128,
        },
        key,
        copiedArrayBuffer(ciphertext),
      );
      const value = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      if (value.length < 20 || value.length > 128) {
        secretUnavailable();
      }
      return value;
    } catch {
      // Authentication failures, corrupt values, and decode failures deliberately
      // share one generic error so ciphertext and key details are not disclosed.
      secretUnavailable();
    }
  }
}

function parseEnabledRegions(value: unknown, partition: AwsPartition): AwsRegionSelection {
  if (!Array.isArray(value) || value.length > MAX_ENABLED_REGIONS) {
    invalidInput("The enabled AWS regions are invalid");
  }

  if (value.length === 1 && value[0] === ALL_ENABLED_AWS_REGIONS) {
    return [ALL_ENABLED_AWS_REGIONS];
  }
  if (value.includes(ALL_ENABLED_AWS_REGIONS)) {
    invalidInput("All enabled AWS regions cannot be combined with an explicit region");
  }

  const unique = new Set<string>();
  for (const region of value) {
    if (typeof region !== "string" || !regionMatchesPartition(region, partition)) {
      invalidInput("The enabled AWS regions are invalid");
    }
    if (unique.has(region)) {
      invalidInput("The enabled AWS regions contain a duplicate");
    }
    unique.add(region);
  }
  return [...unique].sort();
}

function regionMatchesPartition(region: string, partition: AwsPartition): boolean {
  if (partition === "aws-us-gov") {
    return /^us-gov-(?:east|west)-[1-9]\d?$/.test(region);
  }
  if (partition === "aws-cn") {
    return /^cn-(?:north|northwest)-[1-9]\d?$/.test(region);
  }
  return (
    /^[a-z]{2}-[a-z0-9-]+-[1-9]\d?$/.test(region) &&
    !region.startsWith("cn-") &&
    !region.startsWith("us-gov-")
  );
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    invalidInput();
  }
  const allowed = new Set(allowedKeys);
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.has(key)) ||
    allowedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    invalidInput("The request contains missing or unsupported fields");
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredIdentifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    invalidInput("An internal identifier is invalid");
  }
  return value;
}

function requiredAccountId(value: unknown): string {
  if (typeof value !== "string" || !ACCOUNT_ID.test(value) || value === "000000000000") {
    invalidInput("The AWS account ID is invalid");
  }
  return value;
}

function requiredPartition(value: unknown): AwsPartition {
  if (typeof value !== "string" || !PARTITIONS.has(value as AwsPartition)) {
    invalidInput("The AWS partition is invalid");
  }
  return value as AwsPartition;
}

function requiredSafeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_SAFE_COUNT) {
    invalidInput("A sync result count is invalid");
  }
  return value as number;
}

function assertSecretContext(context: SecretContext): void {
  requiredIdentifier(context.orgId);
  requiredIdentifier(context.customerId);
  requiredIdentifier(context.connectionId);
}

function secretAssociatedData(context: SecretContext): ArrayBuffer {
  return copiedArrayBuffer(
    new TextEncoder().encode(
      `sutra:aws-external-id:v1:${context.orgId}:${context.customerId}:${context.connectionId}`,
    ),
  );
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string | undefined, exactLength: number): Uint8Array;
function decodeBase64Url(
  value: string | undefined,
  minimumLength: number,
  maximumLength: number,
): Uint8Array;
function decodeBase64Url(
  value: string | undefined,
  minimumLength: number,
  maximumLength = minimumLength,
): Uint8Array {
  if (!value || !BASE64URL.test(value) || value.length > 512) {
    secretUnavailable();
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  if (binary.length < minimumLength || binary.length > maximumLength) {
    secretUnavailable();
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeConfiguredAesKey(value: string): Uint8Array {
  if (typeof value !== "string" || value.length < 43 || value.length > 44 || /\s/u.test(value)) {
    secretUnavailable();
  }
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    if (!/^[A-Za-z0-9+/]+={0,1}$/u.test(normalized)) {
      secretUnavailable();
    }
    const unpadded = normalized.replace(/=+$/u, "");
    const padding = "=".repeat((4 - (unpadded.length % 4)) % 4);
    const binary = atob(unpadded + padding);
    if (binary.length !== 32) {
      secretUnavailable();
    }
    const bytes = new Uint8Array(32);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    secretUnavailable();
  }
}

/**
 * Canonicalizes the browser-supplied `Origin`, restoring the scheme that TLS
 * termination stripped.
 *
 * THIS IS THE THING THAT BROKE SIGN-IN. TLS terminates at the edge and the internal
 * hop is plain HTTP, so the runtime rewrites `Origin` to match the request URL's
 * scheme: a browser that sent `https://www.sutracmdb.com` arrives as
 * `http://www.sutracmdb.com`. canonicalOrigin rejects a non-HTTPS origin for a
 * non-loopback host, so it THREW on every write — and because it throws the same
 * "The request origin is invalid" message the comparison uses, the failure looked
 * like a mismatch rather than a scheme problem. Confirmed from production:
 * suppliedOrigin `http://www.sutracmdb.com`, expectedOrigin
 * `https://www.sutracmdb.com`, suppliedCanonical THREW.
 *
 * `X-Forwarded-Proto` is the only trustworthy statement of the real client scheme
 * here, and it is safe to trust: the unexposed Caddy front door sets it to a single
 * literal `https` and strips the competing client-supplied headers, so a caller
 * cannot forge an upgrade. Anything other than exactly `https` leaves the supplied
 * origin untouched, so a genuine plaintext request is still rejected.
 */
function suppliedOriginCanonical(request: Request, suppliedOrigin: string): string {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.trim().toLowerCase();
  if (forwardedProto === "https") {
    let host: string | null = null;
    try {
      const parsed = new URL(suppliedOrigin);
      // Only an http->https upgrade of the SAME host. The host is never rewritten,
      // so this cannot turn a foreign origin into the expected one.
      if (parsed.protocol === "http:" && parsed.pathname === "/" && parsed.search === "" && parsed.hash === "") {
        host = parsed.host;
      }
    } catch {
      // Malformed origins fall through to canonicalOrigin, which refuses them.
    }
    if (host !== null) return canonicalOrigin(`https://${host}`);
  }
  return canonicalOrigin(suppliedOrigin);
}

function canonicalOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      invalidInput("The request origin is invalid");
    }
    return url.origin;
  } catch (error) {
    if (error instanceof PilotSecurityError) {
      throw error;
    }
    invalidInput("The request origin is invalid");
  }
}

function invalidInput(message = "The request is invalid"): never {
  throw new PilotSecurityError("INVALID_INPUT", message);
}

function invalidState(message: string): never {
  throw new PilotSecurityError("INVALID_STATE", message);
}

function secretUnavailable(): never {
  throw new PilotSecurityError("SECRET_UNAVAILABLE", "Sensitive configuration is unavailable");
}
