import type { FindingSeverity } from "./pilot-types.ts";

export type ComplianceFrameworkKey =
  | "sutra-aws-baseline"
  | "nist-csf-2.0"
  | "cis-aws-foundations"
  | "iso-27001"
  | "soc-2";

export type ComplianceFrameworkAvailability =
  | "available"
  | "mapping-review-required"
  | "licensed-content-required";

export type ComplianceFrameworkMappingMode =
  | "native"
  | "informative-supporting"
  | "manual"
  | "licensed-manual";

export interface ComplianceFrameworkDefinition {
  readonly key: ComplianceFrameworkKey;
  readonly name: string;
  readonly version: string | null;
  readonly availability: ComplianceFrameworkAvailability;
  readonly mappingMode: ComplianceFrameworkMappingMode;
  readonly description: string;
  readonly claimBoundary: string;
}

/**
 * Category-level NIST CSF 2.0 references only. These are informative
 * relationships, not assertions that a control satisfies a CSF outcome.
 */
export type NistCsf20Category =
  | "PR.AA"
  | "PR.DS"
  | "PR.PS"
  | "PR.IR"
  | "DE.CM"
  | "DE.AE";

export interface ComplianceFrameworkMapping {
  readonly frameworkKey: "nist-csf-2.0";
  readonly relationship: "supports";
  readonly categories: readonly NistCsf20Category[];
  readonly note: string;
}

export type ComplianceControlScope = "account" | "regional" | "resource";
export type ComplianceControlKind = "configuration" | "service-coverage";

export interface ComplianceCoverageRequirement {
  readonly collectorKey: string;
  readonly regionScope: "global" | "regional";
}

export interface ComplianceControlDefinition {
  /** Exact control key emitted by the live AWS collector. */
  readonly key: string;
  /** Exact deterministic evaluator version emitted on a finding. */
  readonly version: "1.0.0";
  readonly title: string;
  readonly description: string;
  readonly severity: FindingSeverity;
  readonly service: string;
  readonly kind: ComplianceControlKind;
  readonly scope: ComplianceControlScope;
  readonly applicableResourceTypes: readonly string[];
  readonly requiredCoverage: readonly ComplianceCoverageRequirement[];
  readonly remediation: string;
  readonly limitation: string;
  readonly frameworkMappings: readonly ComplianceFrameworkMapping[];
}

export interface ComplianceControlCatalog {
  readonly key: "sutra-aws-baseline";
  readonly name: string;
  readonly version: "1.0.0";
  readonly controls: readonly ComplianceControlDefinition[];
  readonly claimBoundary: string;
}

const INFORMATIVE_NIST_NOTE =
  "Informative category-level relationship only; independently validate the applicable NIST CSF 2.0 outcomes.";

function nist(
  ...categories: readonly NistCsf20Category[]
): ComplianceFrameworkMapping {
  return {
    frameworkKey: "nist-csf-2.0",
    relationship: "supports",
    categories,
    note: INFORMATIVE_NIST_NOTE,
  };
}

export const COMPLIANCE_FRAMEWORKS: readonly ComplianceFrameworkDefinition[] = [
  {
    key: "sutra-aws-baseline",
    name: "Sutra AWS Baseline",
    version: "1.0.0",
    availability: "available",
    mappingMode: "native",
    description: "Sutra-owned, deterministic AWS configuration and service-coverage checks.",
    claimBoundary:
      "A result describes only the configuration and collector evidence in the referenced immutable snapshot.",
  },
  {
    key: "nist-csf-2.0",
    name: "NIST Cybersecurity Framework",
    version: "2.0",
    availability: "available",
    mappingMode: "informative-supporting",
    description:
      "High-level supporting relationships to selected NIST CSF 2.0 categories.",
    claimBoundary:
      "Mappings are informative and do not establish implementation of a CSF outcome, conformity, certification, or audit readiness.",
  },
  {
    key: "cis-aws-foundations",
    name: "CIS AWS Foundations Benchmark",
    version: null,
    availability: "licensed-content-required",
    mappingMode: "licensed-manual",
    description:
      "A CIS benchmark mapping is not bundled with this catalog.",
    claimBoundary:
      "Install a properly licensed, current benchmark mapping and complete independent control review before making CIS claims.",
  },
  {
    key: "iso-27001",
    name: "ISO/IEC 27001",
    version: null,
    availability: "licensed-content-required",
    mappingMode: "licensed-manual",
    description:
      "An ISO/IEC 27001 control mapping is not bundled with this catalog.",
    claimBoundary:
      "A licensed control set, organization-specific applicability review, and independent audit evidence are required before making conformity or certification claims.",
  },
  {
    key: "soc-2",
    name: "SOC 2 Trust Services Criteria",
    version: null,
    availability: "mapping-review-required",
    mappingMode: "manual",
    description:
      "A SOC 2 criteria mapping is not bundled with this catalog.",
    claimBoundary:
      "Customer-defined controls, evidence periods, criteria mapping, and independent auditor review are required before making SOC 2 claims.",
  },
] as const;

export const SUTRA_AWS_BASELINE: ComplianceControlCatalog = {
  key: "sutra-aws-baseline",
  name: "Sutra AWS Baseline",
  version: "1.0.0",
  claimBoundary:
    "This baseline is a point-in-time configuration assessment. It is not a penetration test, vulnerability scanner, runtime threat detector, certification, or substitute for AWS-native security services.",
  controls: [
    {
      key: "SUTRA.AWS.EC2.SSH_PUBLIC",
      version: "1.0.0",
      title: "Security group permits public SSH ingress",
      description:
        "Detects a security-group ingress rule that permits TCP port 22 from a public IPv4 or IPv6 CIDR.",
      severity: "high",
      service: "Amazon EC2",
      kind: "configuration",
      scope: "resource",
      applicableResourceTypes: ["aws.ec2.security-group"],
      requiredCoverage: [
        { collectorKey: "ec2.security-groups", regionScope: "regional" },
      ],
      remediation:
        "Restrict SSH to managed administration paths or use Systems Manager Session Manager, then verify the attached network path.",
      limitation:
        "A public rule is an exposure candidate; route, NACL, attachment, public-address, and listener evidence is required to prove internet reachability.",
      frameworkMappings: [nist("PR.PS")],
    },
    {
      key: "SUTRA.AWS.EC2.PUBLIC_IP",
      version: "1.0.0",
      title: "EC2 instance has a public IP",
      description: "Detects an EC2 instance with a directly assigned public IP address.",
      severity: "medium",
      service: "Amazon EC2",
      kind: "configuration",
      scope: "resource",
      applicableResourceTypes: ["aws.ec2.instance"],
      requiredCoverage: [{ collectorKey: "ec2.instances", regionScope: "regional" }],
      remediation:
        "Confirm the full network path, place the workload behind an approved entry point, and remove the public IP where possible.",
      limitation:
        "A public IP alone does not prove that a service is reachable from the internet.",
      frameworkMappings: [nist("PR.PS", "PR.IR")],
    },
    {
      key: "SUTRA.AWS.EC2.IMDSV2_REQUIRED",
      version: "1.0.0",
      title: "EC2 instance metadata does not require IMDSv2",
      description:
        "Detects an EC2 instance whose metadata HttpTokens setting is not required.",
      severity: "high",
      service: "Amazon EC2",
      kind: "configuration",
      scope: "resource",
      applicableResourceTypes: ["aws.ec2.instance"],
      requiredCoverage: [{ collectorKey: "ec2.instances", regionScope: "regional" }],
      remediation:
        "Set HttpTokens to required after validating workload compatibility.",
      limitation:
        "This configuration check does not establish whether an application can be exploited to access instance metadata.",
      frameworkMappings: [nist("PR.AA", "PR.PS")],
    },
    {
      key: "SUTRA.AWS.EC2.SUBNET_AUTO_PUBLIC_IP",
      version: "1.0.0",
      title: "Subnet automatically assigns public IPs",
      description:
        "Detects a subnet whose MapPublicIpOnLaunch setting is enabled.",
      severity: "medium",
      service: "Amazon VPC",
      kind: "configuration",
      scope: "resource",
      applicableResourceTypes: ["aws.ec2.subnet"],
      requiredCoverage: [{ collectorKey: "ec2.subnets", regionScope: "regional" }],
      remediation:
        "Disable automatic public IPv4 assignment unless the subnet has an explicitly approved public-workload purpose.",
      limitation:
        "This setting can assign public addresses, but does not by itself prove an internet route or reachable listener.",
      frameworkMappings: [nist("PR.PS", "PR.IR")],
    },
    {
      key: "SUTRA.AWS.RDS.STORAGE_ENCRYPTED",
      version: "1.0.0",
      title: "RDS storage is not encrypted",
      description:
        "Detects an RDS database instance whose StorageEncrypted setting is false.",
      severity: "high",
      service: "Amazon RDS",
      kind: "configuration",
      scope: "resource",
      applicableResourceTypes: ["aws.rds.db-instance"],
      requiredCoverage: [
        { collectorKey: "rds.db-instances", regionScope: "regional" },
      ],
      remediation:
        "Restore the database from an encrypted snapshot using an approved KMS key and a controlled migration plan.",
      limitation:
        "This check covers the RDS storage-encryption flag, not application-layer encryption or key-management governance.",
      frameworkMappings: [nist("PR.DS")],
    },
    {
      key: "SUTRA.AWS.RDS.PUBLIC_ACCESS",
      version: "1.0.0",
      title: "RDS public-access mode is enabled",
      description:
        "Detects an RDS database instance whose PubliclyAccessible setting is true.",
      severity: "high",
      service: "Amazon RDS",
      kind: "configuration",
      scope: "resource",
      applicableResourceTypes: ["aws.rds.db-instance"],
      requiredCoverage: [
        { collectorKey: "rds.db-instances", regionScope: "regional" },
      ],
      remediation:
        "Confirm the network path, move the database to private subnets, and restrict access to approved application security groups.",
      limitation:
        "The RDS flag alone does not prove that a database endpoint is reachable from the internet.",
      frameworkMappings: [nist("PR.DS", "PR.PS")],
    },
    {
      key: "SUTRA.AWS.S3.PUBLIC_ACCESS_BLOCK",
      version: "1.0.0",
      title: "S3 Public Access Block is incomplete",
      description:
        "Detects an S3 bucket missing one or more Public Access Block settings.",
      severity: "high",
      service: "Amazon S3",
      kind: "configuration",
      scope: "resource",
      applicableResourceTypes: ["aws.s3.bucket"],
      requiredCoverage: [{ collectorKey: "s3.buckets", regionScope: "regional" }],
      remediation:
        "Enable all four S3 Public Access Block settings, then separately review bucket policies and ACLs.",
      limitation:
        "This check does not fully evaluate bucket policies, ACLs, access points, or effective cross-account access.",
      frameworkMappings: [nist("PR.DS", "PR.PS")],
    },
    {
      key: "SUTRA.AWS.CLOUDTRAIL.LOGGING",
      version: "1.0.0",
      title: "CloudTrail regional logging coverage is absent",
      description:
        "Detects a selected Region with no applicable logging regional or multi-Region trail.",
      severity: "critical",
      service: "AWS CloudTrail",
      kind: "service-coverage",
      scope: "regional",
      applicableResourceTypes: [],
      requiredCoverage: [
        { collectorKey: "cloudtrail.trails", regionScope: "regional" },
      ],
      remediation:
        "Create or start an applicable regional or multi-Region trail, then verify event selectors and delivery health separately.",
      limitation:
        "Enablement does not establish event-selector completeness, log integrity, retention, delivery health, or historical coverage.",
      frameworkMappings: [nist("DE.CM")],
    },
    {
      key: "SUTRA.AWS.GUARDDUTY.ENABLED",
      version: "1.0.0",
      title: "GuardDuty is not enabled",
      description: "Detects a selected Region with no enabled GuardDuty detector.",
      severity: "high",
      service: "Amazon GuardDuty",
      kind: "service-coverage",
      scope: "regional",
      applicableResourceTypes: [],
      requiredCoverage: [
        { collectorKey: "guardduty.detectors", regionScope: "regional" },
      ],
      remediation:
        "Review cost and risk, then enable GuardDuty through AWS Organizations for governed Regions or document an approved alternative.",
      limitation:
        "This is an enablement signal. Sutra does not reproduce GuardDuty behavioral analytics or threat intelligence.",
      frameworkMappings: [nist("DE.CM", "DE.AE")],
    },
    {
      key: "SUTRA.AWS.SECURITYHUB.ENABLED",
      version: "1.0.0",
      title: "Security Hub is not enabled",
      description: "Detects a selected Region where AWS Security Hub is not enabled.",
      severity: "medium",
      service: "AWS Security Hub",
      kind: "service-coverage",
      scope: "regional",
      applicableResourceTypes: [],
      requiredCoverage: [{ collectorKey: "securityhub.hub", regionScope: "regional" }],
      remediation:
        "Enable Security Hub and the standards required by the customer baseline after reviewing cost and governance requirements.",
      limitation:
        "This is an enablement signal and does not establish managed-standard coverage or reproduce Security Hub controls.",
      frameworkMappings: [nist("DE.CM", "DE.AE")],
    },
    {
      key: "SUTRA.AWS.IAM.PASSWORD_POLICY",
      version: "1.0.0",
      title: "IAM password policy is not configured",
      description: "Detects an AWS account with no custom IAM account password policy.",
      severity: "medium",
      service: "AWS IAM",
      kind: "configuration",
      scope: "account",
      applicableResourceTypes: [],
      requiredCoverage: [
        { collectorKey: "iam.password-policy", regionScope: "global" },
      ],
      remediation:
        "Prefer federation and configure a strong IAM password policy for any remaining IAM users.",
      limitation:
        "Version 1.0.0 checks policy presence only; it does not fail weak policy values or assess federated identity controls.",
      frameworkMappings: [nist("PR.AA")],
    },
  ],
};

