import type {
  AssumeRoleCommand,
  AssumeRoleCommandOutput,
  GetCallerIdentityCommand,
  GetCallerIdentityCommandOutput,
} from "@aws-sdk/client-sts";

export type AwsPartition = "aws" | "aws-us-gov" | "aws-cn";

export type AwsConnectionStatus =
  | "PENDING"
  | "ACTIVE"
  | "DEGRADED"
  | "DISABLED";

/**
 * Trusted execution context supplied by the queue/API authorization layer. The
 * tenant ID is deliberately separate from the untrusted job body.
 */
export interface ConnectionScope {
  readonly tenantId: string;
  readonly subjectId?: string;
}

/** Server-side connection material. It must never be accepted from a job body. */
export interface StoredAwsConnection {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly expectedAccountId: string;
  readonly roleArn: string;
  readonly externalId: string;
  readonly status: AwsConnectionStatus;
  readonly sessionNamePrefix?: string;
}

export interface ScopedConnectionRegistry {
  resolve(
    scope: ConnectionScope,
    connectionId: string,
  ): Promise<StoredAwsConnection | null>;

  markOnboardingVerified(
    scope: ConnectionScope,
    connectionId: string,
    verification: OnboardingTrustVerification,
  ): Promise<void>;
}

/** Minimal command contract implemented by AWS SDK v3 STSClient and test fakes. */
export interface AssumeRoleClient {
  send(command: AssumeRoleCommand): Promise<AssumeRoleCommandOutput>;
}

/** Uses the newly assumed credentials, never the vendor workload identity. */
export interface CallerIdentityClient {
  send(
    command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput>;
}

export interface AwsTemporaryCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: Date;
}

export type CallerIdentityClientFactory = (
  credentials: AwsTemporaryCredentials,
) => CallerIdentityClient;

export interface RoleContractClient {
  getRole(roleName: string): Promise<{
    readonly arn?: string;
    readonly roleName?: string;
    readonly path?: string;
    readonly maxSessionDuration?: number;
    readonly assumeRolePolicyDocument?: string;
    readonly tags?: readonly { readonly key?: string; readonly value?: string }[];
  }>;
  listRolePolicies(
    roleName: string,
    marker?: string,
  ): Promise<{
    readonly policyNames: readonly string[];
    readonly isTruncated: boolean;
    readonly marker?: string;
  }>;
  getRolePolicy(roleName: string, policyName: string): Promise<{
    readonly policyDocument?: string;
  }>;
}

export type RoleContractClientFactory = (
  credentials: AwsTemporaryCredentials,
) => RoleContractClient;

export interface ParsedIamRoleArn {
  readonly arn: string;
  readonly partition: AwsPartition;
  readonly accountId: string;
  readonly rolePathAndName: string;
  readonly roleName: string;
}

/** Internal-only value passed directly from the broker to an inventory runner. */
export interface ValidatedRoleSession {
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly roleArn: string;
  readonly roleSessionName: string;
  readonly callerIdentityArn: string;
  readonly expiresAt: Date;
  readonly credentials: AwsTemporaryCredentials;
}

/** Safe verification result: intentionally contains no External ID or credentials. */
export interface OnboardingTrustVerification {
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly roleArn: string;
  readonly callerIdentityArn: string;
  readonly roleSessionName: string;
  readonly missingExternalIdDenied: true;
  readonly wrongExternalIdDenied: true;
  readonly trustPolicyAttested: true;
  readonly permissionPolicyAttested: true;
  readonly sessionPolicyApplied: true;
  readonly permissionPackVersion: "live-demo-2026-07";
}

export interface InventoryJobRequest {
  readonly jobId: string;
  readonly connectionId: string;
}

export interface OnboardingVerificationJobRequest {
  readonly jobId: string;
  readonly connectionId: string;
}

export type InventoryCoverage = "COMPLETE" | "PARTIAL";

export type InventoryCollectorCoverageStatus =
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED";

/**
 * Safe, adapter-scoped coverage. Counts describe normalized items that reached
 * the sink and primary AWS list/describe pages that returned successfully.
 * Raw AWS messages are deliberately excluded.
 */
export interface InventoryCollectorCoverage {
  readonly collectorKey: string;
  readonly region: string;
  readonly status: InventoryCollectorCoverageStatus;
  readonly itemsObserved: number;
  readonly pagesObserved: number;
  readonly errorCode?: string;
  readonly message?: string;
}

export type SafeJsonPrimitive = string | number | boolean | null;
export type SafeJsonValue =
  | SafeJsonPrimitive
  | readonly SafeJsonValue[]
  | SafeJsonObject;

export interface SafeJsonObject {
  readonly [key: string]: SafeJsonValue;
}

/**
 * Allowlisted CMDB record. Raw AWS SDK responses, unbounded/sensitive tags,
 * environment variables, credentials, and arbitrary error messages are not
 * valid persistence objects.
 */
export interface NormalizedAwsResource {
  readonly schemaVersion: 1;
  readonly provider: "aws";
  readonly resourceKey: string;
  readonly accountId: string;
  readonly region: string;
  readonly service: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly arn?: string;
  readonly observedAt: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly configuration: SafeJsonObject;
}

export type InventoryEvidenceStatus =
  | "ENABLED"
  | "DISABLED"
  | "CONFIGURED"
  | "NOT_CONFIGURED"
  | "OBSERVED"
  | "ERROR";

/** Security/configuration evidence with only explicitly normalized JSON data. */
export interface NormalizedAwsEvidence {
  readonly schemaVersion: 1;
  readonly provider: "aws";
  readonly evidenceKey: string;
  readonly accountId: string;
  readonly region: string;
  readonly service: string;
  readonly evidenceType: string;
  readonly subjectId: string;
  readonly status: InventoryEvidenceStatus;
  readonly observedAt: string;
  readonly data: SafeJsonObject;
}

export interface AwsInventoryBatch {
  readonly resources: readonly NormalizedAwsResource[];
  readonly evidence: readonly NormalizedAwsEvidence[];
}

/** Production implementations persist/upsert batches inside the tenant boundary. */
export interface AwsInventorySink {
  writeBatch(batch: AwsInventoryBatch): Promise<void>;
}

export interface InventoryCollectionContext {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly roleSessionName: string;
  readonly credentials: AwsTemporaryCredentials;
}

export interface InventoryCollectionResult {
  readonly resourcesObserved: number;
  readonly findingsObserved: number;
  readonly coverage: InventoryCoverage;
  readonly collectorCoverage: readonly InventoryCollectorCoverage[];
}

export interface InventoryRunner {
  collect(context: InventoryCollectionContext): Promise<InventoryCollectionResult>;
}

/** Public handler response. It is constructed from an allowlist of scalar fields. */
export interface InventoryJobResult {
  readonly jobId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly resourcesObserved: number;
  readonly findingsObserved: number;
  readonly coverage: InventoryCoverage;
  readonly completedAt: string;
}

/** Public handler response. It contains no trust material or temporary credentials. */
export interface OnboardingVerificationJobResult {
  readonly jobId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly roleArn: string;
  readonly callerIdentityArn: string;
  readonly missingExternalIdDenied: true;
  readonly wrongExternalIdDenied: true;
  readonly trustPolicyAttested: true;
  readonly permissionPolicyAttested: true;
  readonly sessionPolicyApplied: true;
  readonly permissionPackVersion: "live-demo-2026-07";
  readonly verifiedAt: string;
}

export type CollectorErrorCode =
  | "INVALID_JOB"
  | "CONNECTION_NOT_FOUND"
  | "CONNECTION_SCOPE_VIOLATION"
  | "CONNECTION_STATE_INVALID"
  | "CONNECTION_INTEGRITY_INVALID"
  | "ASSUME_ROLE_FAILED"
  | "STS_RESPONSE_INVALID"
  | "CALLER_IDENTITY_FAILED"
  | "CALLER_IDENTITY_MISMATCH"
  | "TRUST_POLICY_UNSAFE"
  | "NEGATIVE_PROBE_INCONCLUSIVE";

export class CollectorError extends Error {
  public constructor(
    public readonly code: CollectorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidJobError extends CollectorError {
  public constructor(message = "Collector job body is invalid") {
    super("INVALID_JOB", message);
  }
}

export class ConnectionNotFoundError extends CollectorError {
  public constructor() {
    super("CONNECTION_NOT_FOUND", "AWS connection was not found in the scoped registry");
  }
}

export class ConnectionScopeViolationError extends CollectorError {
  public constructor() {
    super(
      "CONNECTION_SCOPE_VIOLATION",
      "Scoped registry returned a connection owned by another tenant",
    );
  }
}

export class ConnectionStateError extends CollectorError {
  public constructor() {
    super(
      "CONNECTION_STATE_INVALID",
      "AWS connection is not in a state allowed for this operation",
    );
  }
}

export class ConnectionIntegrityError extends CollectorError {
  public constructor(message = "Stored AWS connection material failed validation") {
    super("CONNECTION_INTEGRITY_INVALID", message);
  }
}

export class AssumeRoleFailedError extends CollectorError {
  public readonly awsErrorName: string;

  public constructor(awsErrorName: string) {
    super("ASSUME_ROLE_FAILED", "AWS STS AssumeRole failed for the scoped connection");
    this.awsErrorName = awsErrorName;
  }
}

export class StsResponseError extends CollectorError {
  public constructor(message = "AWS STS returned an incomplete response") {
    super("STS_RESPONSE_INVALID", message);
  }
}

export class CallerIdentityFailedError extends CollectorError {
  public readonly awsErrorName: string;

  public constructor(awsErrorName: string) {
    super(
      "CALLER_IDENTITY_FAILED",
      "AWS STS GetCallerIdentity failed for the assumed session",
    );
    this.awsErrorName = awsErrorName;
  }
}

export class IdentityMismatchError extends CollectorError {
  public constructor() {
    super(
      "CALLER_IDENTITY_MISMATCH",
      "Assumed AWS identity does not match the registered customer account and role",
    );
  }
}

export type NegativeExternalIdProbe =
  | "MISSING_EXTERNAL_ID"
  | "WRONG_EXTERNAL_ID"
  | "ROLE_CONTRACT";

export class UnsafeTrustPolicyError extends CollectorError {
  public constructor(public readonly probe: NegativeExternalIdProbe) {
    super(
      "TRUST_POLICY_UNSAFE",
      probe === "ROLE_CONTRACT"
        ? "Customer role does not match the reviewed Sutra trust and permission contract"
        : "Customer role accepted an onboarding request that did not contain the exact registered External ID",
    );
  }
}

export class NegativeProbeInconclusiveError extends CollectorError {
  public readonly probe: NegativeExternalIdProbe;
  public readonly awsErrorName: string;

  public constructor(probe: NegativeExternalIdProbe, awsErrorName: string) {
    super(
      "NEGATIVE_PROBE_INCONCLUSIVE",
      "External ID trust-policy probe did not return an authorization denial",
    );
    this.probe = probe;
    this.awsErrorName = awsErrorName;
  }
}
