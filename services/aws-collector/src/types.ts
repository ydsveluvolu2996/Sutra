import type {
  AssumeRoleCommand,
  AssumeRoleCommandOutput,
  GetCallerIdentityCommand,
  GetCallerIdentityCommandOutput,
} from "@aws-sdk/client-sts";

export type AwsPartition = "aws" | "aws-us-gov" | "aws-cn";
/**
 * The pack a freshly deployed template grants. Bumped whenever the exact action
 * set changes, because attestation compares the role's granted actions to
 * IMPLEMENTED_READ_ACTIONS as an EXACT set for sutra_template roles.
 *
 * .3 adds ec2:DescribeFlowLogs (VPC flow-log coverage).
 * .4 adds Amazon Bedrock guardrail, invocation-logging, and account
 * data-retention posture.
 *
 * A connection still recorded against an older pack is rejected by
 * assumeValidatedSession BEFORE attestation runs, so the customer sees a clear
 * "redeploy your role" state rather than an opaque role-contract failure. That
 * ordering is the whole point of this constant: without the bump, an old role
 * would fail the action-set comparison with no actionable explanation.
 */
export const CURRENT_PERMISSION_PACK_VERSION = "standard-2026-07.4" as const;
/**
 * Separately published successor ceiling used only by the Foundational FinOps
 * object broker. It is intentionally not CURRENT_PERMISSION_PACK_VERSION:
 * regular inventory/onboarding remains pinned to .4 until the whole product
 * permission pack is promoted. The successor grants no S3/Data Exports reads
 * by itself; an independently attested immutable add-on is mandatory.
 */
export const FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION = "standard-2026-08.1" as const;
/**
 * Successor ceiling for signed organization taxonomy and account-local
 * Trusted Advisor standard checks. It remains separate from the regular .4
 * inventory pack and the .8.1 Foundational-only successor.
 */
export const ORGANIZATION_FINOPS_PERMISSION_PACK_VERSION = "standard-2026-08.2" as const;
/**
 * Immutable successor that adds only Compute Optimizer enrollment and completed
 * export-job discovery. Export creation and S3 object access remain outside the
 * base role and require separate server-owned contracts.
 */
export const ADVANCED_FINOPS_PERMISSION_PACK_VERSION = "standard-2026-08.3" as const;
/**
 * Immutable successor for exact Compute Optimizer export-object reads. The
 * base role adds only GetObjectVersion and GenerateDataKey to the .8.3 deny
 * ceiling; every S3 prefix and optional CMK remains in a server-owned add-on.
 */
export const COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION =
  "standard-2026-08.4" as const;
export const COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_CONTRACT_ID =
  "compute-optimizer-export-read-v1" as const;
/**
 * Immutable successor required for launching the eight supported Compute
 * Optimizer recommendation exports. The base role only opens its explicit
 * deny ceiling; a separately attested, regional launch contract supplies the
 * exact 25 launch/dependency grants and the sealed SSE-KMS destination prefix.
 */
export const COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION =
  "standard-2026-08.5" as const;
export const COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_CONTRACT_ID =
  "compute-optimizer-export-launch-v1" as const;
/**
 * Immutable successor for ADV-04. It preserves .8.5 and adds only the exact
 * fourteen Extended Support inventory, lifecycle and public-pricing reads.
 */
export const EXTENDED_SUPPORT_PERMISSION_PACK_VERSION =
  "standard-2026-08.6" as const;
/**
 * Superseded packs are still ACCEPTED AS STORED VALUES so that existing registry
 * records stay readable and can report "needs upgrade". They are deliberately not
 * rotated out of the union: dropping one would make an existing record fail
 * integrity parsing outright, which is strictly worse than a clear upgrade
 * prompt.
 */
export const PRIOR_PERMISSION_PACK_VERSION = "standard-2026-07.3" as const;
export const PREVIOUS_PERMISSION_PACK_VERSION = "standard-2026-07.2" as const;
export const OLDER_PERMISSION_PACK_VERSION = "standard-2026-07" as const;
export const LEGACY_PERMISSION_PACK_VERSION = "live-demo-2026-07.1" as const;
export type PermissionPackVersion =
  | typeof CURRENT_PERMISSION_PACK_VERSION
  | typeof FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION
  | typeof ORGANIZATION_FINOPS_PERMISSION_PACK_VERSION
  | typeof ADVANCED_FINOPS_PERMISSION_PACK_VERSION
  | typeof COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION
  | typeof COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION
  | typeof EXTENDED_SUPPORT_PERMISSION_PACK_VERSION
  | typeof PRIOR_PERMISSION_PACK_VERSION
  | typeof PREVIOUS_PERMISSION_PACK_VERSION
  | typeof OLDER_PERMISSION_PACK_VERSION
  | typeof LEGACY_PERMISSION_PACK_VERSION;

export type FoundationalFinopsContractId =
  | "foundational-cur2-export-v1"
  | "foundational-focus12-export-v1";

/**
 * Server-owned copy of immutable CloudFormation outputs. This value is never
 * accepted from a collector request. It binds an add-on policy to one tenant,
 * connection, account, export, bucket and prefix.
 */
export interface FoundationalFinopsAddOnContract {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly contractId: FoundationalFinopsContractId;
  readonly exportTable: "COST_AND_USAGE_REPORT" | "FOCUS_1_2_AWS";
  readonly policyName:
    | "SutraFoundationalCur2ReadV1"
    | "SutraFoundationalFocus12ReadV1";
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly exportName: string;
  readonly exportArn: string;
}

export interface FoundationalFinopsBindingRequest {
  readonly contractId: FoundationalFinopsContractId;
  readonly exportName: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
}

/**
 * Immutable, server-owned identity for one AWS FinOps source integration.
 *
 * Requests carry only `contractId`. AWS operations, endpoints, account scope,
 * partition and region are all derived from this persisted contract and the
 * collector's compiled source catalog.
 */
export interface FinopsSourceContract {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly contractId: string;
  readonly sourceId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly region: string;
  readonly permissionContractId: string | null;
  readonly policyName: string | null;
}

export type ComputeOptimizerExportObjectEncryptionMode = "SSE_S3" | "SSE_KMS";

/**
 * Server-owned immutable binding for one regional Compute Optimizer provider
 * prefix. Public jobs carry only its opaque contractId plus an exact object
 * address already sealed by the export plan.
 */
export interface ComputeOptimizerExportObjectContract {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly region: string;
  readonly contractId: string;
  readonly permissionPackVersion:
    typeof COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION;
  readonly permissionContractId:
    typeof COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_CONTRACT_ID;
  readonly policyName: string;
  readonly bucket: string;
  readonly effectivePrefix: string;
  readonly encryptionMode: ComputeOptimizerExportObjectEncryptionMode;
  readonly kmsKeyArn: string | null;
}

/** Server-owned copy of one regional launch add-on's immutable outputs. */
export interface ComputeOptimizerExportLaunchContract {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly region: string;
  readonly contractId: string;
  readonly permissionPackVersion:
    typeof COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION;
  readonly permissionContractId:
    typeof COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_CONTRACT_ID;
  readonly policyName: string;
  readonly bucket: string;
  readonly bucketArn: string;
  readonly basePrefix: string;
  readonly effectivePrefix: string;
  readonly objectArnPrefix: string;
  readonly encryptionMode: "SSE_KMS";
  readonly kmsKeyArn: string;
  readonly bucketVersioningStatus: "Enabled";
  readonly servicePrincipal: "compute-optimizer.amazonaws.com";
}

/**
 * Server-produced proof used by the encrypted registry's explicit .8.5
 * promotion edge. Contract values are derived from collector-owned
 * CloudFormation outputs and then re-attested against the live customer role;
 * no HTTP/browser request is allowed to construct this value.
 */
export interface ComputeOptimizerExportLaunchProvisioningVerification {
  readonly schemaVersion:
    "sutra.compute-optimizer-export-launch-provisioning-verification.v1";
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly roleArn: string;
  readonly permissionPackVersion:
    typeof COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION;
  readonly enabledRegions: readonly string[];
  readonly sourceContracts: readonly FinopsSourceContract[];
  readonly objectContracts: readonly ComputeOptimizerExportObjectContract[];
  readonly launchContracts: readonly ComputeOptimizerExportLaunchContract[];
  readonly baseRoleOutputsSha256: string;
  readonly regionalObjectReadOutputsSha256: string;
  readonly regionalLaunchOutputsSha256: string;
  readonly identityAttested: true;
  readonly permissionPolicyAttested: true;
  readonly launchPoliciesAttested: true;
  readonly stackOutputsAttested: true;
}

export type AwsConnectionStatus =
  | "PENDING"
  | "VERIFIED"
  | "ACTIVE"
  | "DEGRADED"
  | "DISABLED";

export type AwsRoleProvisioningMode = "sutra_template" | "customer_managed";

export interface PermissionCapabilityAssessment {
  readonly grantedActions: readonly string[];
  readonly missingActions: readonly string[];
}

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
  readonly permissionPackVersion: PermissionPackVersion;
  readonly sessionNamePrefix?: string;
  /**
   * Optional only for backwards compatibility with encrypted records created
   * before customer-managed dedicated roles were introduced. The broker
   * resolves missing values to the canonical Sutra template contract.
   */
  readonly roleProvisioningMode?: AwsRoleProvisioningMode;
  readonly expectedRolePath?: string;
  readonly expectedRoleName?: string;
  /**
   * Optional for old records and for successor records awaiting operator
   * attestation. Missing is fail-closed on every FinOps object request.
   */
  readonly foundationalFinopsContracts?: readonly FoundationalFinopsAddOnContract[];
  /**
   * Persisted by the trusted control plane. Public collector requests cannot
   * create or modify these source bindings.
   */
  readonly finopsSourceContracts?: readonly FinopsSourceContract[];
  /** Exact regional S3/KMS bindings for the .8.4 object broker. */
  readonly computeOptimizerExportObjectContracts?:
    readonly ComputeOptimizerExportObjectContract[];
  /** Exact regional launch/destination attestations for the .8.5 broker. */
  readonly computeOptimizerExportLaunchContracts?:
    readonly ComputeOptimizerExportLaunchContract[];
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
  listAttachedRolePolicies(
    roleName: string,
    marker?: string,
  ): Promise<{
    readonly policies: readonly {
      readonly policyName?: string;
      readonly policyArn?: string;
    }[];
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
  readonly permissionPackVersion: typeof CURRENT_PERMISSION_PACK_VERSION;
  readonly capabilityAssessment: PermissionCapabilityAssessment;
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
  /** Exact read-only AWS API provenance for this normalized record. */
  readonly sourceApi?: string;
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
  readonly roleSessionName: string;
  readonly callerIdentityArn: string;
  readonly missingExternalIdDenied: true;
  readonly wrongExternalIdDenied: true;
  readonly trustPolicyAttested: true;
  readonly permissionPolicyAttested: true;
  readonly sessionPolicyApplied: true;
  readonly permissionPackVersion: typeof CURRENT_PERMISSION_PACK_VERSION;
  readonly capabilityAssessment: PermissionCapabilityAssessment;
  readonly verifiedAt: string;
}

export type CollectorErrorCode =
  | "INVALID_JOB"
  | "CONNECTION_NOT_FOUND"
  | "CONNECTION_SCOPE_VIOLATION"
  | "CONNECTION_STATE_INVALID"
  | "CONNECTION_INTEGRITY_INVALID"
  | "ASSUME_ROLE_DENIED"
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

export class AssumeRoleDeniedError extends CollectorError {
  public readonly awsErrorName: string;

  public constructor(awsErrorName: string) {
    super("ASSUME_ROLE_DENIED", "AWS denied AssumeRole for the scoped connection");
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
