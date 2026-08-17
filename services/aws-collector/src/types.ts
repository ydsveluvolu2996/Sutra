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
 * Immutable successor for ADV-09. It preserves .8.6 and adds only the exact
 * two account-local AWS Support case reads; no Support mutation is permitted.
 */
export const AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION =
  "standard-2026-08.7" as const;
/**
 * Immutable successor for ADV-06. It preserves .8.7 and adds only the exact
 * AWS Health organization-view reads and Organizations prerequisite proofs.
 */
export const AWS_HEALTH_PERMISSION_PACK_VERSION =
  "standard-2026-08.8" as const;
/**
 * Immutable successor for ADV-10. It preserves .8.8 and adds only the exact
 * fourteen AWS Resilience Hub read operations used by ResilienceVue.
 */
export const RESILIENCE_VUE_PERMISSION_PACK_VERSION =
  "standard-2026-08.9" as const;
/**
 * Immutable successor for ADV-12. It preserves .8.9 and adds only the three
 * Step Functions metadata operations scoped to server-declared DCF machines.
 */
export const DCF_STEP_FUNCTIONS_PERMISSION_PACK_VERSION =
  "standard-2026-08.10" as const;
/**
 * Immutable successor for ADV-11. It preserves .8.10 and adds only the exact
 * eight AppStream, WorkSpaces, and CloudWatch reads used by End User Computing.
 */
export const END_USER_COMPUTING_PERMISSION_PACK_VERSION =
  "standard-2026-08.11" as const;
/** Immutable successor for ADV-05 Graviton Savings exact read-only APIs. */
export const GRAVITON_SAVINGS_PERMISSION_PACK_VERSION =
  "standard-2026-08.12" as const;
/**
 * Immutable successor for ADD-05. It preserves .8.12 and adds only the ten
 * buyer-side AWS Marketplace and License Manager reads. Product catalog reads are
 * absent: aws-marketplace:GetProduct is a real AWS Marketplace Discovery action
 * but is missing from the cfn-lint IAM catalog, so it is withheld from the
 * template until its resource-type support is confirmed.
 */
export const AWS_MARKETPLACE_PERMISSION_PACK_VERSION =
  "standard-2026-08.13" as const;
/**
 * Immutable successor for ADD-01 CORA. It preserves .8.13 and adds only the
 * eleven read-only Cost Optimization Hub, Data Export and export-object reads.
 * Enrollment and export registration stay provisioner-only writes.
 */
export const COST_OPTIMIZATION_HUB_PERMISSION_PACK_VERSION =
  "standard-2026-08.14" as const;
/**
 * Immutable successor for ADD-08 Sustainability. It preserves .8.14 and adds only
 * the single carbon Data Export authorization read. The direct emissions APIs are
 * not granted: this vertical reads a CARBON_EMISSIONS export from S3.
 */
export const SUSTAINABILITY_CARBON_PERMISSION_PACK_VERSION =
  "standard-2026-08.15" as const;
/**
 * Immutable successor for ADD-11. It preserves .8.15 and adds only the three
 * Amazon Connect and Directory Service reads. Neither service supports a
 * resource ARN for them, so the deny ceiling is the only available bound.
 */
export const AMAZON_CONNECT_PERMISSION_PACK_VERSION =
  "standard-2026-08.16" as const;
/**
 * Immutable successor for ADD-13. It preserves .8.16 and grants no new action:
 * both Price List reads are already permitted for ADV-05. It exists so a Pricing
 * Change connection is attested against its own named source contract.
 */
export const AWS_PRICING_CATALOG_PERMISSION_PACK_VERSION =
  "standard-2026-08.17" as const;
/**
 * Immutable successor for ADD-12. It preserves .8.17 and adds only the thirteen
 * read-only AWS Config aggregator, rule-lifecycle and recorder reads.
 */
export const AWS_CONFIG_COMPLIANCE_PERMISSION_PACK_VERSION =
  "standard-2026-08.18" as const;
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
  | typeof AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION
  | typeof AWS_HEALTH_PERMISSION_PACK_VERSION
  | typeof RESILIENCE_VUE_PERMISSION_PACK_VERSION
  | typeof DCF_STEP_FUNCTIONS_PERMISSION_PACK_VERSION
  | typeof END_USER_COMPUTING_PERMISSION_PACK_VERSION
  | typeof GRAVITON_SAVINGS_PERMISSION_PACK_VERSION
  | typeof AWS_MARKETPLACE_PERMISSION_PACK_VERSION
  | typeof COST_OPTIMIZATION_HUB_PERMISSION_PACK_VERSION
  | typeof SUSTAINABILITY_CARBON_PERMISSION_PACK_VERSION
  | typeof AMAZON_CONNECT_PERMISSION_PACK_VERSION
  | typeof AWS_PRICING_CATALOG_PERMISSION_PACK_VERSION
  | typeof AWS_CONFIG_COMPLIANCE_PERMISSION_PACK_VERSION
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

/**
 * How a connection authenticates to AWS. Absent on records written before
 * static credentials existed; absence always means "trust_role".
 */
export type AwsConnectionCredentialKind = "trust_role" | "static_credentials";

/**
 * Customer-supplied static credential material. It exists only inside the
 * encrypted registry document and in-memory session construction; it is never
 * logged, never echoed by any route, and never persisted anywhere else.
 * The reviewed persistent path accepts only a long-term AKIA key from a
 * dedicated IAM user. The optional token remains for decoding the disabled
 * legacy hosted envelope and is rejected by every live onboarding boundary.
 */
export interface AwsStaticCredentialMaterial {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
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
  /**
   * Absent for every record written before static credentials existed and for
   * all trust-role connections. When "static_credentials", roleArn and
   * externalId are empty strings, staticCredentials is present, and partition
   * pins the expected identity partition (a trust-role session derives it
   * from the role ARN instead).
   */
  readonly credentialKind?: AwsConnectionCredentialKind;
  readonly staticCredentials?: AwsStaticCredentialMaterial;
  readonly partition?: AwsPartition;
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

/**
 * Safe static-credential verification result: proves the supplied key pair
 * authenticates as the expected account. Contains no secret material — only
 * the last four characters of the (non-secret) access key ID for display.
 */
export interface StaticCredentialVerification {
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly callerIdentityArn: string;
  readonly accessKeyLast4: string;
  /** Present for the Secrets Manager-backed path; absent only in legacy fixtures. */
  readonly secretVersionId?: string;
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
