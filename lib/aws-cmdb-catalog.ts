import generatedCatalog from "../data/aws-cmdb-catalog.v1.json" with { type: "json" };
import type { AwsPartition } from "./pilot-types.ts";

export type AwsCatalogScope = "global" | "regional" | "unknown";

export interface AwsCatalogMaturity {
  readonly cataloged: true;
  readonly adapterPlanned: boolean;
  readonly implemented: boolean;
  readonly externallyAccepted: boolean;
  readonly unavailable: boolean;
}

export interface AwsCatalogResourceType {
  readonly id: string;
  readonly name: string;
  readonly href: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly origin: "reference_catalog" | "sutra_extension";
  readonly referenceCoverage: boolean;
  readonly taggable: boolean;
  readonly scope: AwsCatalogScope;
  readonly partitions: readonly AwsPartition[];
  readonly normalizedResourceType: string | null;
  readonly collectorKey: string | null;
  readonly requiredOperations: readonly string[];
  readonly requirementsState: "implemented" | "not_assessed";
  readonly maturity: AwsCatalogMaturity;
}

export interface AwsCatalogService {
  readonly id: string;
  readonly name: string;
  readonly href: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly resourceTypes: readonly AwsCatalogResourceType[];
}

export interface AwsCatalogCategory {
  readonly id: string;
  readonly name: string;
  readonly href: string;
  readonly services: readonly AwsCatalogService[];
}

interface GeneratedResourceType {
  readonly id: string;
  readonly name: string;
  readonly referenceCoverage: boolean;
  readonly taggable: boolean;
}

interface GeneratedService {
  readonly id: string;
  readonly name: string;
  readonly href: string;
  readonly resourceTypes: readonly GeneratedResourceType[];
}

interface GeneratedCategory {
  readonly id: string;
  readonly name: string;
  readonly href: string;
  readonly services: readonly GeneratedService[];
}

interface GeneratedCatalog {
  readonly schemaVersion: "sutra.aws-cmdb-catalog.v1";
  readonly catalogVersion: string;
  readonly source: {
    readonly navigatorCategoryCount: number;
    readonly navigatorServiceCount: number;
    readonly capturedResourceCoverageRecordCount: number;
    readonly usableResourceCoverageTypeCount: number;
    readonly taggableResourceTypeCount: number;
    readonly unionResourceTypeCount: number;
    readonly resourceCoverageSha256: string;
    readonly taggableResourceTypesSha256: string;
    readonly navigatorRoutesSha256: string;
    readonly anomalies: readonly string[];
  };
  readonly categories: readonly GeneratedCategory[];
}

interface ImplementedBinding {
  readonly normalizedResourceType: string;
  readonly collectorKey: string;
  readonly scope: Exclude<AwsCatalogScope, "unknown">;
  readonly requiredOperations: readonly string[];
}

const CONNECTION_PARTITIONS = Object.freeze(["aws", "aws-us-gov", "aws-cn"] as const);

/**
 * Existing production collector types are bound explicitly instead of inferred
 * from similarly named catalog rows. A name joins this table only when the
 * collector, normalization, durable CMDB projection and tenant-scoped serving
 * path already exist. External acceptance remains a separate maturity flag.
 */
const IMPLEMENTED_BINDINGS: Readonly<Record<string, ImplementedBinding>> = Object.freeze({
  "AWS Account": {
    normalizedResourceType: "aws.iam.account",
    collectorKey: "iam.account",
    scope: "global",
    requiredOperations: ["iam:GetAccountSummary"],
  },
  "AWS Bedrock Guardrail": {
    normalizedResourceType: "aws.bedrock.guardrail",
    collectorKey: "bedrock.guardrails",
    scope: "regional",
    requiredOperations: ["bedrock:GetGuardrail", "bedrock:ListGuardrails", "bedrock:ListTagsForResource"],
  },
  "AWS CloudTrail Trail": {
    normalizedResourceType: "aws.cloudtrail.trail",
    collectorKey: "cloudtrail.trails",
    scope: "regional",
    requiredOperations: ["cloudtrail:DescribeTrails", "cloudtrail:GetTrailStatus", "cloudtrail:ListTags"],
  },
  "AWS DynamoDB Table": {
    normalizedResourceType: "aws.dynamodb.table",
    collectorKey: "dynamodb.tables",
    scope: "regional",
    requiredOperations: ["dynamodb:DescribeTable", "dynamodb:ListTables", "dynamodb:ListTagsOfResource"],
  },
  "AWS EBS Snapshot": {
    normalizedResourceType: "aws.ec2.snapshot",
    collectorKey: "ec2.snapshots",
    scope: "regional",
    requiredOperations: ["ec2:DescribeSnapshots"],
  },
  "AWS EBS Volume": {
    normalizedResourceType: "aws.ec2.volume",
    collectorKey: "ec2.volumes",
    scope: "regional",
    requiredOperations: ["ec2:DescribeVolumes"],
  },
  "AWS EC2 Elastic IP": {
    normalizedResourceType: "aws.ec2.elastic-ip",
    collectorKey: "ec2.elastic-ips",
    scope: "regional",
    requiredOperations: ["ec2:DescribeAddresses"],
  },
  "AWS EC2 Instance": {
    normalizedResourceType: "aws.ec2.instance",
    collectorKey: "ec2.instances",
    scope: "regional",
    requiredOperations: ["ec2:DescribeInstances"],
  },
  "AWS EC2 Network Interface": {
    normalizedResourceType: "aws.ec2.network-interface",
    collectorKey: "ec2.network-interfaces",
    scope: "regional",
    requiredOperations: ["ec2:DescribeNetworkInterfaces"],
  },
  "AWS EC2 Security Group": {
    normalizedResourceType: "aws.ec2.security-group",
    collectorKey: "ec2.security-groups",
    scope: "regional",
    requiredOperations: ["ec2:DescribeSecurityGroups"],
  },
  "AWS ECR Repository": {
    normalizedResourceType: "aws.ecr.repository",
    collectorKey: "ecr.repositories",
    scope: "regional",
    requiredOperations: ["ecr:DescribeRepositories", "ecr:ListTagsForResource"],
  },
  "AWS EKS Cluster": {
    normalizedResourceType: "aws.eks.cluster",
    collectorKey: "eks.clusters",
    scope: "regional",
    requiredOperations: ["eks:DescribeCluster", "eks:ListClusters", "eks:ListTagsForResource"],
  },
  "AWS ELB Load Balancer": {
    normalizedResourceType: "aws.elasticloadbalancingv2.load-balancer",
    collectorKey: "elbv2.load-balancers",
    scope: "regional",
    requiredOperations: ["elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeListeners"],
  },
  "AWS ELB Load Balancer Listener": {
    normalizedResourceType: "aws.elasticloadbalancingv2.listener",
    collectorKey: "elbv2.load-balancers",
    scope: "regional",
    requiredOperations: ["elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeLoadBalancers"],
  },
  "AWS ELB Load Balancer Target Group": {
    normalizedResourceType: "aws.elasticloadbalancingv2.target-group",
    collectorKey: "elbv2.target-groups",
    scope: "regional",
    requiredOperations: ["elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetHealth"],
  },
  "AWS GuardDuty Detector": {
    normalizedResourceType: "aws.guardduty.detector",
    collectorKey: "guardduty.detectors",
    scope: "regional",
    requiredOperations: ["guardduty:GetDetector", "guardduty:ListDetectors"],
  },
  "AWS KMS Key": {
    normalizedResourceType: "aws.kms.key",
    collectorKey: "kms.keys",
    scope: "regional",
    requiredOperations: ["kms:DescribeKey", "kms:ListKeys", "kms:ListResourceTags"],
  },
  "AWS RDS Instance": {
    normalizedResourceType: "aws.rds.db-instance",
    collectorKey: "rds.db-instances",
    scope: "regional",
    requiredOperations: ["rds:DescribeDBInstances", "rds:ListTagsForResource"],
  },
  "AWS S3 Bucket": {
    normalizedResourceType: "aws.s3.bucket",
    collectorKey: "s3.buckets",
    scope: "regional",
    requiredOperations: ["s3:GetBucketLocation", "s3:GetBucketTagging", "s3:ListAllMyBuckets"],
  },
  "AWS Security Hub": {
    normalizedResourceType: "aws.securityhub.hub",
    collectorKey: "securityhub.hub",
    scope: "regional",
    requiredOperations: ["securityhub:DescribeHub"],
  },
  "AWS VPC": {
    normalizedResourceType: "aws.ec2.vpc",
    collectorKey: "ec2.vpcs",
    scope: "regional",
    requiredOperations: ["ec2:DescribeVpcs"],
  },
  "AWS VPC Flow Log": {
    normalizedResourceType: "aws.ec2.flow-log",
    collectorKey: "ec2.flow-logs",
    scope: "regional",
    requiredOperations: ["ec2:DescribeFlowLogs"],
  },
  "AWS VPC Internet Gateway": {
    normalizedResourceType: "aws.ec2.internet-gateway",
    collectorKey: "ec2.internet-gateways",
    scope: "regional",
    requiredOperations: ["ec2:DescribeInternetGateways"],
  },
  "AWS VPC Network ACL": {
    normalizedResourceType: "aws.ec2.network-acl",
    collectorKey: "ec2.network-acls",
    scope: "regional",
    requiredOperations: ["ec2:DescribeNetworkAcls"],
  },
  "AWS VPC Route Table": {
    normalizedResourceType: "aws.ec2.route-table",
    collectorKey: "ec2.route-tables",
    scope: "regional",
    requiredOperations: ["ec2:DescribeRouteTables"],
  },
  "AWS VPC Subnet": {
    normalizedResourceType: "aws.ec2.subnet",
    collectorKey: "ec2.subnets",
    scope: "regional",
    requiredOperations: ["ec2:DescribeSubnets"],
  },
});

const PLANNED_NETWORK_TYPES = new Set([
  "AWS Direct Connect Connection",
  "AWS Direct Connect Gateway",
  "AWS Direct Connect Virtual Interface",
  "AWS VPC Customer Gateway",
  "AWS VPC Endpoint",
  "AWS VPC Endpoint Service",
  "AWS VPC NAT Gateway",
  "AWS VPC Peering Connection",
  "AWS VPC TG Route Table Propagation",
  "AWS VPC Transit Gateway",
  "AWS VPC Transit Gateway Attachment",
  "AWS VPC Transit Gateway Route Table",
  "AWS VPC VPN Connection",
  "AWS VPC Virtual Private Gateway",
]);

const SSM_PATCH_STATE_EXTENSION: Omit<AwsCatalogResourceType, "categoryId" | "categoryName" | "serviceId" | "serviceName" | "href"> = {
  id: "sutra-aws-ssm-instance-patch-state",
  name: "Sutra AWS SSM Instance Patch State",
  origin: "sutra_extension",
  referenceCoverage: false,
  taggable: false,
  scope: "regional",
  partitions: CONNECTION_PARTITIONS,
  normalizedResourceType: "aws.ssm.patch-state",
  collectorKey: "ssm.patch-states",
  requiredOperations: ["ssm:DescribeInstanceInformation", "ssm:DescribeInstancePatches", "ssm:DescribeInstancePatchStates"],
  requirementsState: "implemented",
  maturity: {
    cataloged: true,
    adapterPlanned: true,
    implemented: true,
    externallyAccepted: false,
    unavailable: false,
  },
};

function checkedGeneratedCatalog(value: unknown): GeneratedCatalog {
  const catalog = value as Partial<GeneratedCatalog>;
  if (catalog.schemaVersion !== "sutra.aws-cmdb-catalog.v1"
    || catalog.source?.navigatorCategoryCount !== 18
    || catalog.source.navigatorServiceCount !== 114
    || catalog.source.capturedResourceCoverageRecordCount !== 978
    || catalog.source.usableResourceCoverageTypeCount !== 977
    || catalog.source.taggableResourceTypeCount !== 317
    || catalog.source.unionResourceTypeCount !== 986
    || catalog.categories?.length !== 18) {
    throw new Error("The generated AWS CMDB catalog failed its version/count contract");
  }
  return catalog as GeneratedCatalog;
}

function maturity(name: string, binding: ImplementedBinding | undefined): AwsCatalogMaturity {
  return {
    cataloged: true,
    adapterPlanned: binding !== undefined || PLANNED_NETWORK_TYPES.has(name),
    implemented: binding !== undefined,
    externallyAccepted: false,
    unavailable: false,
  };
}

const generated = checkedGeneratedCatalog(generatedCatalog);

const categories: readonly AwsCatalogCategory[] = Object.freeze(generated.categories.map((category) => {
  const services: AwsCatalogService[] = category.services.map((service) => {
    const resourceTypes: AwsCatalogResourceType[] = service.resourceTypes.map((type) => {
      const binding = IMPLEMENTED_BINDINGS[type.name];
      return {
        ...type,
        href: `${service.href}/${type.id}`,
        categoryId: category.id,
        categoryName: category.name,
        serviceId: service.id,
        serviceName: service.name,
        origin: "reference_catalog",
        scope: binding?.scope ?? "unknown",
        partitions: binding === undefined ? [] : CONNECTION_PARTITIONS,
        normalizedResourceType: binding?.normalizedResourceType ?? null,
        collectorKey: binding?.collectorKey ?? null,
        requiredOperations: binding?.requiredOperations ?? [],
        requirementsState: binding === undefined ? "not_assessed" : "implemented",
        maturity: maturity(type.name, binding),
      };
    });
    if (service.id === "aws-ssm") {
      resourceTypes.push({
        ...SSM_PATCH_STATE_EXTENSION,
        href: `${service.href}/${SSM_PATCH_STATE_EXTENSION.id}`,
        categoryId: category.id,
        categoryName: category.name,
        serviceId: service.id,
        serviceName: service.name,
      });
    }
    return {
      id: service.id,
      name: service.name,
      href: service.href,
      categoryId: category.id,
      categoryName: category.name,
      resourceTypes: Object.freeze(resourceTypes),
    };
  });
  return {
    id: category.id,
    name: category.name,
    href: category.href,
    services: Object.freeze(services),
  };
}));

const services = Object.freeze(categories.flatMap((category) => category.services));
const resourceTypes = Object.freeze(services.flatMap((service) => service.resourceTypes));
const categoryById = new Map(categories.map((category) => [category.id, category]));
const serviceById = new Map(services.map((service) => [service.id, service]));
const typeByScopedId = new Map(resourceTypes.map((type) => [`${type.serviceId}/${type.id}`, type]));
const typeByNormalizedResourceType = new Map(resourceTypes.flatMap((type) =>
  type.normalizedResourceType === null ? [] : [[type.normalizedResourceType, type] as const]));

if (services.length !== 114 || resourceTypes.length !== 987 || typeByNormalizedResourceType.size !== 27) {
  throw new Error("The canonical AWS CMDB catalog failed its integration contract");
}

export const AWS_CMDB_CATALOG = Object.freeze({
  schemaVersion: generated.schemaVersion,
  catalogVersion: generated.catalogVersion,
  source: Object.freeze(generated.source),
  categories,
  services,
  resourceTypes,
});

export function findAwsCatalogCategory(id: string): AwsCatalogCategory | null {
  return categoryById.get(id) ?? null;
}

export function findAwsCatalogService(id: string): AwsCatalogService | null {
  return serviceById.get(id) ?? null;
}

export function findAwsCatalogResourceType(serviceId: string, typeId: string): AwsCatalogResourceType | null {
  return typeByScopedId.get(`${serviceId}/${typeId}`) ?? null;
}

export function findAwsCatalogResourceTypeByNormalizedType(normalizedResourceType: string): AwsCatalogResourceType | null {
  return typeByNormalizedResourceType.get(normalizedResourceType) ?? null;
}
