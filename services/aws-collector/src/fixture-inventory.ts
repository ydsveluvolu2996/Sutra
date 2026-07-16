import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

import type { RegisteredAwsConnection } from "./local-registry.js";
import type { SafeJsonObject, SafeJsonValue } from "./types.js";

export interface PilotResource {
  readonly resourceKey: string;
  readonly service: string;
  readonly resourceType: string;
  readonly nativeId: string;
  readonly arn: string | null;
  readonly name: string | null;
  readonly region: string;
  readonly state: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly configuration: SafeJsonObject;
  readonly source: {
    readonly api: string;
    readonly accountId: string;
    readonly collectedAt: string;
  };
  readonly contentSha256: string;
}

export interface PilotRelationship {
  readonly fromResourceKey: string;
  readonly toResourceKey: string;
  readonly relationType: string;
  readonly evidence: SafeJsonObject;
}

export interface PilotFinding {
  readonly fingerprint: string;
  readonly resourceKey: string | null;
  readonly controlKey: string;
  readonly controlVersion: string;
  readonly severity: "critical" | "high" | "medium" | "low" | "informational";
  readonly status: "open";
  readonly title: string;
  readonly summary: string;
  readonly remediation: string;
  readonly evidence: SafeJsonObject;
  readonly evaluatedAt: string;
}

export interface PilotCoverageEntry {
  readonly collectorKey: string;
  readonly region: string;
  readonly status: "succeeded" | "partial" | "failed" | "skipped";
  readonly itemsObserved: number;
  readonly pagesObserved: number;
  readonly errorCode?: string;
  readonly message?: string;
}

export interface UnsignedPilotSnapshot {
  readonly schemaVersion: "sutra.inventory.v1";
  readonly jobId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly roleSessionName: string;
  readonly collectedAt: string;
  readonly coverageState: "complete" | "partial";
  readonly coverage: readonly PilotCoverageEntry[];
  readonly resources: readonly PilotResource[];
  readonly relationships: readonly PilotRelationship[];
  readonly findings: readonly PilotFinding[];
}

export interface PilotSnapshot extends UnsignedPilotSnapshot {
  readonly snapshotSha256: string;
}

export interface FixtureSnapshotInput {
  readonly jobId: string;
  readonly connection: RegisteredAwsConnection;
  readonly now?: Date;
}

/** The evidence fields mirrored by lib/pilot-boundary.ts and serialized canonically. */
export function snapshotHashInput(payload: UnsignedPilotSnapshot): string {
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

export function finalizePilotSnapshot(payload: UnsignedPilotSnapshot): PilotSnapshot {
  return {
    ...payload,
    snapshotSha256: sha256(snapshotHashInput(payload)),
  };
}

export function buildFixtureSnapshot(input: FixtureSnapshotInput): PilotSnapshot {
  const collectedAt = (input.now ?? new Date()).toISOString();
  const accountId = input.connection.expectedAccountId;
  const partition = input.connection.partition;
  const regions = input.connection.enabledRegions;
  const primaryRegion = regions[0] ?? "us-east-1";
  const secondaryRegion = regions[1] ?? primaryRegion;

  const iamAccount = fixtureResource({
    accountId,
    partition,
    collectedAt,
    region: "global",
    service: "iam",
    resourceType: "aws.iam.account",
    nativeId: accountId,
    arn: `arn:${partition}:iam::${accountId}:root`,
    name: "AWS account",
    state: "active",
    tags: {},
    api: "iam:GetAccountSummary",
    configuration: {
      users: 14,
      roles: 37,
      policies: 22,
      accountMfaEnabled: 1,
      passwordPolicy: {
        minimumPasswordLength: 8,
        requireSymbols: false,
        requireNumbers: true,
        requireUppercaseCharacters: true,
        requireLowercaseCharacters: true,
        passwordReusePrevention: 3,
      },
    },
  });
  const vpc = fixtureResource({
    accountId,
    partition,
    collectedAt,
    region: primaryRegion,
    service: "ec2",
    resourceType: "aws.ec2.vpc",
    nativeId: "vpc-0a12b34c56d78e901",
    arn: `arn:${partition}:ec2:${primaryRegion}:${accountId}:vpc/vpc-0a12b34c56d78e901`,
    name: "production-vpc",
    state: "available",
    tags: { Name: "production-vpc", Environment: "production", Owner: "platform" },
    api: "ec2:DescribeVpcs",
    configuration: { cidrBlock: "10.20.0.0/16", isDefault: false },
  });
  const publicSubnet = fixtureResource({
    accountId,
    partition,
    collectedAt,
    region: primaryRegion,
    service: "ec2",
    resourceType: "aws.ec2.subnet",
    nativeId: "subnet-0ab12cd34ef56a789",
    arn: `arn:${partition}:ec2:${primaryRegion}:${accountId}:subnet/subnet-0ab12cd34ef56a789`,
    name: "production-public-a",
    state: "available",
    tags: { Name: "production-public-a", Tier: "public" },
    api: "ec2:DescribeSubnets",
    configuration: {
      vpcId: vpc.nativeId,
      cidrBlock: "10.20.1.0/24",
      availabilityZone: `${primaryRegion}a`,
      mapPublicIpOnLaunch: true,
      availableIpAddressCount: 218,
    },
  });
  const privateSubnet = fixtureResource({
    accountId,
    partition,
    collectedAt,
    region: primaryRegion,
    service: "ec2",
    resourceType: "aws.ec2.subnet",
    nativeId: "subnet-0f98e76d54c32b101",
    arn: `arn:${partition}:ec2:${primaryRegion}:${accountId}:subnet/subnet-0f98e76d54c32b101`,
    name: "production-private-a",
    state: "available",
    tags: { Name: "production-private-a", Tier: "private" },
    api: "ec2:DescribeSubnets",
    configuration: {
      vpcId: vpc.nativeId,
      cidrBlock: "10.20.11.0/24",
      availabilityZone: `${primaryRegion}a`,
      mapPublicIpOnLaunch: false,
      availableIpAddressCount: 201,
    },
  });
  const webSg = fixtureResource({
    accountId,
    partition,
    collectedAt,
    region: primaryRegion,
    service: "ec2",
    resourceType: "aws.ec2.security-group",
    nativeId: "sg-0123abc456def7890",
    arn: `arn:${partition}:ec2:${primaryRegion}:${accountId}:security-group/sg-0123abc456def7890`,
    name: "web-edge",
    state: "active",
    tags: { Name: "web-edge", Environment: "production" },
    api: "ec2:DescribeSecurityGroups",
    configuration: {
      vpcId: vpc.nativeId,
      ingress: [
        { protocol: "tcp", fromPort: 443, toPort: 443, ipv4Cidrs: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 22, toPort: 22, ipv4Cidrs: ["0.0.0.0/0"] },
      ],
      egress: [{ protocol: "-1", ipv4Cidrs: ["0.0.0.0/0"] }],
    },
  });
  const appSg = fixtureResource({
    accountId,
    partition,
    collectedAt,
    region: primaryRegion,
    service: "ec2",
    resourceType: "aws.ec2.security-group",
    nativeId: "sg-0fedcba9876543210",
    arn: `arn:${partition}:ec2:${primaryRegion}:${accountId}:security-group/sg-0fedcba9876543210`,
    name: "application",
    state: "active",
    tags: { Name: "application", Environment: "production" },
    api: "ec2:DescribeSecurityGroups",
    configuration: {
      vpcId: vpc.nativeId,
      ingress: [
        {
          protocol: "tcp",
          fromPort: 8080,
          toPort: 8080,
          referencedSecurityGroupIds: [webSg.nativeId],
        },
      ],
      egress: [{ protocol: "-1", ipv4Cidrs: ["0.0.0.0/0"] }],
    },
  });
  const webInstance = fixtureResource({
    accountId,
    partition,
    collectedAt,
    region: primaryRegion,
    service: "ec2",
    resourceType: "aws.ec2.instance",
    nativeId: "i-01a2b3c4d5e6f7890",
    arn: `arn:${partition}:ec2:${primaryRegion}:${accountId}:instance/i-01a2b3c4d5e6f7890`,
    name: "customer-portal-01",
    state: "running",
    tags: { Name: "customer-portal-01", Environment: "production", PatchGroup: "linux" },
    api: "ec2:DescribeInstances",
    configuration: {
      instanceType: "t3.medium",
      architecture: "x86_64",
      vpcId: vpc.nativeId,
      subnetId: publicSubnet.nativeId,
      securityGroupIds: [webSg.nativeId],
      privateIpAddress: "10.20.1.24",
      publicIpAddress: "198.51.100.24",
      metadataHttpTokens: "optional",
    },
  });
  const workerInstance = fixtureResource({
    accountId,
    partition,
    collectedAt,
    region: secondaryRegion,
    service: "ec2",
    resourceType: "aws.ec2.instance",
    nativeId: "i-0f9e8d7c6b5a43210",
    arn: `arn:${partition}:ec2:${secondaryRegion}:${accountId}:instance/i-0f9e8d7c6b5a43210`,
    name: "batch-worker-01",
    state: "stopped",
    tags: { Name: "batch-worker-01", Environment: "development" },
    api: "ec2:DescribeInstances",
    configuration: {
      instanceType: "t3.small",
      architecture: "arm64",
      privateIpAddress: "10.42.8.17",
      metadataHttpTokens: "required",
    },
  });
  const bucket = fixtureResource({
    accountId,
    partition,
    collectedAt,
    region: primaryRegion,
    service: "s3",
    resourceType: "aws.s3.bucket",
    nativeId: `sutra-customer-assets-${accountId}`,
    arn: `arn:${partition}:s3:::sutra-customer-assets-${accountId}`,
    name: `sutra-customer-assets-${accountId}`,
    state: "active",
    tags: { Environment: "production", DataClass: "customer" },
    api: "s3:ListBuckets",
    configuration: {
      bucketRegion: primaryRegion,
      blockPublicAcls: false,
      ignorePublicAcls: false,
      blockPublicPolicy: false,
      restrictPublicBuckets: false,
      versioning: "suspended",
      defaultEncryption: "AES256",
    },
  });
  const database = fixtureResource({
    accountId,
    partition,
    collectedAt,
    region: primaryRegion,
    service: "rds",
    resourceType: "aws.rds.db-instance",
    nativeId: "customer-db-1",
    arn: `arn:${partition}:rds:${primaryRegion}:${accountId}:db:customer-db-1`,
    name: "customer-db-1",
    state: "available",
    tags: { Environment: "production", DataClass: "restricted" },
    api: "rds:DescribeDBInstances",
    configuration: {
      engine: "postgres",
      engineVersion: "16.4",
      instanceClass: "db.t4g.medium",
      allocatedStorageGiB: 100,
      storageEncrypted: false,
      publiclyAccessible: true,
      multiAz: false,
      vpcId: vpc.nativeId,
      securityGroupIds: [appSg.nativeId],
    },
  });
  const trail = fixtureResource({
    accountId,
    partition,
    collectedAt,
    region: primaryRegion,
    service: "cloudtrail",
    resourceType: "aws.cloudtrail.trail",
    nativeId: "organization-audit",
    arn: `arn:${partition}:cloudtrail:${primaryRegion}:${accountId}:trail/organization-audit`,
    name: "organization-audit",
    state: "stopped",
    tags: {},
    api: "cloudtrail:DescribeTrails",
    configuration: {
      homeRegion: primaryRegion,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      logFileValidationEnabled: false,
      isLogging: false,
    },
  });
  const guardDuty = fixtureResource({
    accountId,
    partition,
    collectedAt,
    region: primaryRegion,
    service: "guardduty",
    resourceType: "aws.guardduty.detector",
    nativeId: "detector-fixture-1",
    arn: `arn:${partition}:guardduty:${primaryRegion}:${accountId}:detector/detector-fixture-1`,
    name: "GuardDuty detector",
    state: "disabled",
    tags: {},
    api: "guardduty:ListDetectors",
    configuration: { status: "DISABLED", findingPublishingFrequency: "SIX_HOURS" },
  });
  const securityHub = fixtureResource({
    accountId,
    partition,
    collectedAt,
    region: primaryRegion,
    service: "securityhub",
    resourceType: "aws.securityhub.hub",
    nativeId: `${accountId}:${primaryRegion}:hub`,
    arn: null,
    name: "Security Hub",
    state: "disabled",
    tags: {},
    api: "securityhub:DescribeHub",
    configuration: { enabled: false },
  });

  const resources = [
    iamAccount,
    vpc,
    publicSubnet,
    privateSubnet,
    webSg,
    appSg,
    webInstance,
    workerInstance,
    bucket,
    database,
    trail,
    guardDuty,
    securityHub,
  ];
  const relationships: PilotRelationship[] = [
    relationship(publicSubnet, vpc, "contained_by", { property: "vpcId" }),
    relationship(privateSubnet, vpc, "contained_by", { property: "vpcId" }),
    relationship(webSg, vpc, "contained_by", { property: "vpcId" }),
    relationship(appSg, vpc, "contained_by", { property: "vpcId" }),
    relationship(webInstance, publicSubnet, "runs_in", { property: "subnetId" }),
    relationship(webInstance, webSg, "protected_by", { property: "securityGroupIds" }),
    relationship(database, vpc, "runs_in", { property: "vpcId" }),
    relationship(database, appSg, "protected_by", { property: "securityGroupIds" }),
    relationship(appSg, webSg, "allows_from", { port: 8080, protocol: "tcp" }),
  ];

  const findings: PilotFinding[] = [
    finding(collectedAt, webSg, "SUTRA.AWS.EC2.SSH_PUBLIC", "high",
      "Security group permits public SSH ingress",
      "The security group permits TCP/22 from 0.0.0.0/0. Route, NACL, attachment, and public-address evidence is still required to prove reachability.",
      "Restrict SSH to a managed bastion, VPN CIDR, or AWS Systems Manager Session Manager.",
      { cidr: "0.0.0.0/0", fromPort: 22, toPort: 22 }),
    finding(collectedAt, webInstance, "SUTRA.AWS.EC2.PUBLIC_IP", "medium",
      "EC2 instance has a public IPv4 address",
      "The production portal has a public IPv4 address. Route, NACL, security-group, and listener evidence is still required to prove internet reachability.",
      "Place the workload behind a load balancer and remove the instance public IP where possible.",
      { publicIpPresent: true }),
    finding(collectedAt, webInstance, "SUTRA.AWS.EC2.IMDSV2_REQUIRED", "high",
      "EC2 metadata service allows IMDSv1",
      "HttpTokens is optional, so requests can use the legacy metadata protocol.",
      "Set MetadataOptions.HttpTokens to required after checking workload compatibility.",
      { metadataHttpTokens: "optional" }),
    finding(collectedAt, publicSubnet, "SUTRA.AWS.EC2.SUBNET_AUTO_PUBLIC_IP", "medium",
      "Subnet automatically assigns public IP addresses",
      "New instances launched in this subnet receive public IPv4 addresses by default.",
      "Disable MapPublicIpOnLaunch and explicitly expose only approved entry points.",
      { mapPublicIpOnLaunch: true }),
    finding(collectedAt, bucket, "SUTRA.AWS.S3.PUBLIC_ACCESS_BLOCK", "high",
      "S3 account protections are not enforced on this bucket",
      "All four S3 Public Access Block settings are disabled for a customer-data bucket.",
      "Enable all S3 Public Access Block settings, then validate policies and ACLs before removing public access.",
      { blockPublicAcls: false, blockPublicPolicy: false, restrictPublicBuckets: false }),
    finding(collectedAt, database, "SUTRA.AWS.RDS.STORAGE_ENCRYPTED", "high",
      "RDS storage is not encrypted",
      "The database contains restricted data but StorageEncrypted is false.",
      "Create an encrypted snapshot copy with a customer-managed KMS key and restore into a new encrypted instance.",
      { storageEncrypted: false }),
    finding(collectedAt, database, "SUTRA.AWS.RDS.PUBLIC_ACCESS", "critical",
      "RDS public-accessibility flag is enabled",
      "The production database has PubliclyAccessible enabled. This is exposure evidence, not proof of an end-to-end reachable network path.",
      "Move the database to private subnets, disable public accessibility, and permit traffic only from application security groups.",
      { publiclyAccessible: true }),
    finding(collectedAt, trail, "SUTRA.AWS.CLOUDTRAIL.LOGGING", "critical",
      "CloudTrail logging is stopped",
      "The multi-Region audit trail exists but is not currently delivering events.",
      "Start the trail, enable log-file validation, and alert on delivery failures.",
      { isLogging: false, logFileValidationEnabled: false }),
    finding(collectedAt, guardDuty, "SUTRA.AWS.GUARDDUTY.ENABLED", "high",
      "GuardDuty is disabled in the primary Region",
      "No enabled GuardDuty detector is providing managed threat-detection telemetry.",
      "Enable GuardDuty through AWS Organizations and review detector coverage for every governed Region.",
      { enabledDetectorCount: 0 }),
    finding(collectedAt, securityHub, "SUTRA.AWS.SECURITYHUB.ENABLED", "medium",
      "Security Hub is disabled in the primary Region",
      "AWS-native findings are not being aggregated into a regional Security Hub.",
      "Enable Security Hub and the standards required by your compliance program; keep Sutra configuration checks as complementary evidence.",
      { enabled: false }),
    finding(collectedAt, iamAccount, "SUTRA.AWS.IAM.PASSWORD_POLICY", "medium",
      "IAM password policy is below the baseline",
      "The minimum length is 8 and symbols are not required.",
      "Prefer federation; for remaining IAM users, require at least 14 characters and strong reuse controls.",
      { minimumPasswordLength: 8, requireSymbols: false }),
  ];

  const coverage = fixtureCoverage(regions, resources);
  return finalizePilotSnapshot({
    schemaVersion: "sutra.inventory.v1",
    jobId: input.jobId,
    connectionId: input.connection.connectionId,
    accountId,
    partition,
    roleSessionName: fixtureRoleSessionName(input.jobId),
    collectedAt,
    coverageState: "complete",
    coverage,
    resources,
    relationships,
    findings,
  });
}

export function fixtureRoleSessionName(jobId: string): string {
  return `sutra-fixture-${sha256(jobId).slice(0, 16)}`;
}

export function fixtureCallerIdentityArn(
  connection: RegisteredAwsConnection,
  jobId: string,
): string {
  const roleName = connection.roleArn.split("/").at(-1) ?? "SutraReadOnlyRole";
  return `arn:${connection.partition}:sts::${connection.expectedAccountId}:assumed-role/${roleName}/${fixtureRoleSessionName(jobId)}`;
}

interface FixtureResourceInput {
  readonly accountId: string;
  readonly partition: string;
  readonly collectedAt: string;
  readonly region: string;
  readonly service: string;
  readonly resourceType: string;
  readonly nativeId: string;
  readonly arn: string | null;
  readonly name: string | null;
  readonly state: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly api: string;
  readonly configuration: SafeJsonObject;
}

function fixtureResource(input: FixtureResourceInput): PilotResource {
  const resourceKey = `${input.partition}:${input.accountId}:${input.region}:${input.service}:${input.resourceType}:${input.nativeId}`;
  const unsigned = {
    resourceKey,
    service: input.service,
    resourceType: input.resourceType,
    nativeId: input.nativeId,
    arn: input.arn,
    name: input.name,
    region: input.region,
    state: input.state,
    tags: input.tags,
    configuration: input.configuration,
    source: { api: input.api, accountId: input.accountId, collectedAt: input.collectedAt },
  };
  return { ...unsigned, contentSha256: sha256(JSON.stringify(unsigned)) };
}

function relationship(
  from: PilotResource,
  to: PilotResource,
  relationType: string,
  evidence: SafeJsonObject,
): PilotRelationship {
  return {
    fromResourceKey: from.resourceKey,
    toResourceKey: to.resourceKey,
    relationType,
    evidence,
  };
}

function finding(
  evaluatedAt: string,
  resource: PilotResource,
  controlKey: string,
  severity: PilotFinding["severity"],
  title: string,
  summary: string,
  remediation: string,
  evidence: SafeJsonObject,
): PilotFinding {
  return {
    fingerprint: sha256(`${controlKey}:${resource.resourceKey}`).slice(0, 48),
    resourceKey: resource.resourceKey,
    controlKey,
    controlVersion: "1.0.0",
    severity,
    status: "open",
    title,
    summary,
    remediation,
    evidence,
    evaluatedAt,
  };
}

function fixtureCoverage(
  regions: readonly string[],
  resources: readonly PilotResource[],
): PilotCoverageEntry[] {
  const result: PilotCoverageEntry[] = [
    coverageEntry("iam.account", "global", resources),
    coverageEntry("iam.password-policy", "global", resources),
    coverageEntry("s3.buckets", "global", resources),
  ];
  for (const region of regions) {
    for (const collector of [
      "ec2.instances",
      "ec2.vpcs",
      "ec2.subnets",
      "ec2.security-groups",
      "rds.db-instances",
      "cloudtrail.trails",
      "guardduty.detectors",
      "securityhub.hub",
    ]) {
      result.push(coverageEntry(collector, region, resources));
    }
  }
  return result;
}

function coverageEntry(
  collectorKey: string,
  region: string,
  resources: readonly PilotResource[],
): PilotCoverageEntry {
  const resourceType = collectorResourceType(collectorKey);
  return {
    collectorKey,
    region,
    status: "succeeded",
    itemsObserved: resources.filter(
      (resource) => resource.resourceType === resourceType && (region === "global" || resource.region === region),
    ).length,
    pagesObserved: 1,
  };
}

function collectorResourceType(collectorKey: string): string {
  const types: Readonly<Record<string, string>> = {
    "iam.account": "aws.iam.account",
    "iam.password-policy": "aws.iam.account",
    "s3.buckets": "aws.s3.bucket",
    "ec2.instances": "aws.ec2.instance",
    "ec2.vpcs": "aws.ec2.vpc",
    "ec2.subnets": "aws.ec2.subnet",
    "ec2.security-groups": "aws.ec2.security-group",
    "rds.db-instances": "aws.rds.db-instance",
    "cloudtrail.trails": "aws.cloudtrail.trail",
    "guardduty.detectors": "aws.guardduty.detector",
    "securityhub.hub": "aws.securityhub.hub",
  };
  return types[collectorKey] ?? `unknown.${collectorKey}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Narrow a safe JSON value without ever evaluating or stringifying secret data. */
export function isSafeJsonObject(value: SafeJsonValue): value is SafeJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
