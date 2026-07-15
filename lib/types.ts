export type CustomerId = string;
export type AwsAccountId = string;
export type ResourceId = string;

export type CustomerStatus = "active" | "trial" | "suspended";
export type CustomerPlan = "foundation" | "managed" | "enterprise";

export interface Customer {
  id: CustomerId;
  name: string;
  slug: string;
  status: CustomerStatus;
  plan: CustomerPlan;
  primaryContact: string;
  accountIds: readonly AwsAccountId[];
  createdAt: string;
  /** Demo records must never be confused with discovered customer data. */
  isDemo: boolean;
}

export type ConnectionStatus = "connected" | "needs-attention" | "pending";
export type SignalState = "enabled" | "disabled" | "unknown";
export type CoverageState = SignalState | "partial";

export interface AccountSecuritySignals {
  rootMfa: SignalState;
  passwordPolicy: SignalState;
  cloudTrail: {
    status: SignalState;
    coveredRegions: readonly string[];
  };
  guardDuty: {
    status: CoverageState;
    coveredRegions: readonly string[];
  };
  observedAt: string;
}

export interface AwsAccount {
  id: AwsAccountId;
  customerId: CustomerId;
  awsAccountId: string;
  name: string;
  environment: "production" | "development" | "staging" | "sandbox";
  regions: readonly string[];
  trustRole: {
    roleArn: string;
    externalIdConfigured: boolean;
    permissionsMode: "read-only";
    status: ConnectionStatus;
    lastValidatedAt: string | null;
  };
  securitySignals: AccountSecuritySignals;
  lastSyncedAt: string;
  isDemo: boolean;
}

export type ResourceState =
  | "active"
  | "available"
  | "in-use"
  | "running"
  | "stopped"
  | "unknown";

export interface ResourceBase {
  id: ResourceId;
  customerId: CustomerId;
  accountId: AwsAccountId;
  arn: string;
  nativeId: string;
  name: string;
  region: string;
  state: ResourceState;
  tags: Readonly<Record<string, string>>;
  lastSeenAt: string;
}

export interface S3BucketResource extends ResourceBase {
  service: "s3";
  resourceType: "s3-bucket";
  configuration: {
    publicAccess: "blocked" | "restricted" | "public" | "unknown";
    blockPublicAccessEnabled: boolean | null;
    encryptionEnabled: boolean | null;
    versioningEnabled: boolean | null;
  };
}

export interface EbsVolumeResource extends ResourceBase {
  service: "ec2";
  resourceType: "ebs-volume";
  configuration: {
    encrypted: boolean | null;
    kmsKeyId: string | null;
    sizeGiB: number;
    volumeType: string;
  };
}

export interface Ec2InstanceResource extends ResourceBase {
  service: "ec2";
  resourceType: "ec2-instance";
  configuration: {
    instanceType: string;
    platform: string;
    publicIpAddress: string | null;
    securityGroupIds: readonly string[];
  };
}

export interface RdsInstanceResource extends ResourceBase {
  service: "rds";
  resourceType: "rds-instance";
  configuration: {
    engine: string;
    encrypted: boolean | null;
    publiclyAccessible: boolean | null;
    multiAz: boolean | null;
  };
}

export interface IamAccessKey {
  id: string;
  status: "active" | "inactive";
  ageDays: number;
  lastUsedDaysAgo: number | null;
}

export interface IamUserResource extends ResourceBase {
  service: "iam";
  resourceType: "iam-user";
  region: "global";
  configuration: {
    consoleAccess: boolean;
    mfaEnabled: boolean | null;
    accessKeys: readonly IamAccessKey[];
  };
}

export interface LambdaFunctionResource extends ResourceBase {
  service: "lambda";
  resourceType: "lambda-function";
  configuration: {
    runtime: string;
    publicFunctionUrl: boolean | null;
  };
}

export interface LoadBalancerResource extends ResourceBase {
  service: "elasticloadbalancing";
  resourceType: "load-balancer";
  configuration: {
    scheme: "internet-facing" | "internal";
    loadBalancerType: "application" | "network";
    securityGroupIds: readonly string[];
  };
}

export interface VpcResource extends ResourceBase {
  service: "vpc";
  resourceType: "vpc";
  configuration: {
    cidrBlock: string;
    isDefault: boolean;
  };
}

export type NormalizedResource =
  | S3BucketResource
  | EbsVolumeResource
  | Ec2InstanceResource
  | RdsInstanceResource
  | IamUserResource
  | LambdaFunctionResource
  | LoadBalancerResource
  | VpcResource;

export type SecurityGroupProtocol = "-1" | "tcp" | "udp" | "icmp";

export interface SecurityGroupRule {
  id: string;
  protocol: SecurityGroupProtocol;
  fromPort: number | null;
  toPort: number | null;
  ipv4Ranges: readonly string[];
  ipv6Ranges: readonly string[];
  sourceSecurityGroupIds: readonly string[];
  description: string;
}

export interface SecurityGroup {
  id: string;
  customerId: CustomerId;
  accountId: AwsAccountId;
  groupId: string;
  name: string;
  description: string;
  region: string;
  vpcId: string;
  isDefault: boolean;
  ingress: readonly SecurityGroupRule[];
  egress: readonly SecurityGroupRule[];
  lastSeenAt: string;
}

export type Severity = "critical" | "high" | "medium" | "low" | "informational";
export type ControlCategory =
  | "exposure"
  | "encryption"
  | "identity"
  | "logging"
  | "coverage";

export type SecurityControlId =
  | "aws.s3.public-access"
  | "aws.ec2.security-group.open-ssh"
  | "aws.ec2.security-group.open-rdp"
  | "aws.ec2.ebs.unencrypted"
  | "aws.rds.unencrypted"
  | "aws.rds.public-access"
  | "aws.iam.root-mfa-disabled"
  | "aws.iam.password-policy-missing"
  | "aws.iam.access-key-stale"
  | "aws.ec2.default-security-group-ingress"
  | "aws.cloudtrail.absent"
  | "aws.guardduty.coverage-incomplete";

export interface SecurityControl {
  id: SecurityControlId;
  title: string;
  description: string;
  category: ControlCategory;
  severity: Severity;
  scope: "account" | "resource" | "security-group";
  services: readonly string[];
  remediation: string;
  detectionMode: "configuration";
  limitation: string;
}

export type FindingTarget =
  | { type: "account"; id: AwsAccountId; name: string }
  | { type: "resource"; id: ResourceId; name: string }
  | { type: "security-group"; id: string; name: string };

export type FindingEvidenceValue = string | number | boolean | readonly string[];

export interface SecurityFinding {
  id: string;
  customerId: CustomerId;
  accountId: AwsAccountId;
  controlId: SecurityControlId;
  title: string;
  description: string;
  category: ControlCategory;
  severity: Severity;
  status: "open" | "acknowledged" | "resolved" | "suppressed";
  service: string;
  region: string;
  target: FindingTarget;
  evidence: Readonly<Record<string, FindingEvidenceValue>>;
  remediation: string;
  observedAt: string;
  source: "deterministic-configuration-check";
  capability: "configuration-assessment";
}

export interface SecurityInventory {
  accounts: readonly AwsAccount[];
  resources: readonly NormalizedResource[];
  securityGroups: readonly SecurityGroup[];
}

export interface PostureSummary {
  total: number;
  bySeverity: Readonly<Record<Severity, number>>;
  byCategory: Readonly<Record<ControlCategory, number>>;
  affectedAccounts: number;
  affectedResources: number;
}
