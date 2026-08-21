import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const navigatorPath = resolve(root, "docs/research/cloudaware-aws-product-map/raw/aws-navigator-routes.json");
const coveragePath = resolve(root, "docs/research/cloudaware-aws-product-map/raw/aws-resource-coverage.txt");
const taggablePath = resolve(root, "docs/research/cloudaware-aws-product-map/raw/aws-taggable-resource-types.txt");
const outputPath = resolve(root, "data/aws-cmdb-catalog.v1.json");

const SERVICE_BY_PREFIX = Object.freeze({
  ACM: "aws-certificate-manager",
  API: "aws-api-gateway",
  Account: "aws-organizations",
  App: "aws-app-mesh",
  AppStream: "aws-app-stream",
  Athena: "aws-athena",
  AutoScaling: "aws-auto-scaling",
  Availability: "aws-vpc",
  Backup: "aws-backup",
  Batch: "aws-batch",
  Bedrock: "aws-bedrock",
  Budget: "aws-budgets",
  CloudFormation: "aws-cloud-formation",
  CloudFront: "aws-cloud-front",
  CloudHSM: "aws-cloud-hsm",
  CloudMap: "aws-cloud-map",
  CloudSearch: "aws-cloud-search",
  CloudTrail: "aws-cloud-trail",
  CloudWatch: "aws-cloud-watch",
  CodeBuild: "aws-code-build",
  CodeCommit: "aws-code-commit",
  CodeDeploy: "aws-code-deploy",
  CodePipeline: "aws-code-pipeline",
  Cognito: "aws-cognito",
  Comprehend: "aws-comprehend",
  Compute: "aws-compute-optimizer",
  Config: "aws-config",
  Connect: "aws-connect",
  CostExplorer: "aws-cost-explorer",
  DAX: "aws-dax",
  DMS: "aws-dms",
  Data: "aws-data-sync",
  DataSync: "aws-data-sync",
  Direct: "aws-direct-connect",
  Directory: "aws-directory-service",
  DynamoDB: "aws-dynamo-db",
  EBS: "aws-ec2",
  EC2: "aws-ec2",
  ECR: "aws-ecr",
  ECS: "aws-ecs",
  EFS: "aws-efs",
  EKS: "aws-eks",
  ELB: "aws-elb",
  EMR: "aws-emr",
  ElastiCache: "aws-elasti-cache",
  Elastic: "aws-elastic-beanstalk",
  EventBridge: "aws-event-bridge",
  FSx: "aws-fsx",
  Firewall: "aws-firewall-manager",
  Glacier: "aws-glacier",
  GlobalAccelerator: "aws-global-accelerator",
  Glue: "aws-glue",
  GuardDuty: "aws-guard-duty",
  IAM: "aws-iam",
  IPAM: "aws-ipam",
  IoT: "aws-iot-core",
  KMS: "aws-kms",
  Kendra: "aws-kendra",
  Kinesis: "aws-kinesis",
  Lambda: "aws-lambda",
  Lex: "aws-lexv2",
  License: "aws-license-manager",
  LicenseManager: "aws-license-manager",
  Lightsail: "aws-lightsail",
  MQ: "aws-mq",
  MSK: "aws-msk",
  MWAA: "aws-mwaa",
  Managed: "aws-managed-blockchain",
  MedLive: "aws-media-live",
  MediaConnect: "aws-media-connect",
  MediaConvert: "aws-media-convert",
  MediaLive: "aws-media-live",
  MediaPackage: "aws-media-package",
  MediaStore: "aws-media-store",
  MediaTailor: "aws-media-tailor",
  NetworkFirewall: "aws-network-firewall",
  OpenSearch: "aws-opensearch",
  OpsWorks: "aws-ops-works",
  Organization: "aws-organizations",
  Organizational: "aws-organizations",
  Polly: "aws-polly",
  QuickSight: "aws-quicksight",
  RAM: "aws-ram",
  RDS: "aws-rds",
  Redshift: "aws-redshift",
  Region: "aws-vpc",
  Rekognition: "aws-rekognition",
  Route53: "aws-route53",
  S3: "aws-s3",
  SES: "aws-ses",
  SNS: "aws-sns",
  SQS: "aws-sqs",
  SSM: "aws-ssm",
  SWF: "aws-swf",
  SageMaker: "aws-sagemaker",
  Savings: "aws-savings-plans",
  Secrets: "aws-secrets-manager",
  Security: "aws-security-hub",
  Service: "aws-service-catalog",
  Shield: "aws-shield",
  Snowball: "aws-snowball",
  Step: "aws-step-functions",
  Storage: "aws-storage-gateway",
  Tape: "aws-backup",
  Textract: "aws-textract",
  Transcribe: "aws-transcribe",
  VPC: "aws-vpc",
  Verified: "aws-verified-access",
  Volume: "aws-backup",
  WA: "aws-well-architected-tool",
  WAF: "aws-waf",
  WorkSpace: "aws-work-spaces",
  WorkSpaces: "aws-work-spaces",
  "X-Ray": "aws-xray",
});

function fail(message) {
  throw new Error(`AWS CMDB catalog generation failed: ${message}`);
}

function lines(value) {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function slug(value) {
  const normalized = value
    .normalize("NFKD")
    .replace(/^AWS\s+/u, "")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLocaleLowerCase("en-US");
  if (normalized.length === 0) fail(`could not create a slug for ${JSON.stringify(value)}`);
  return `aws-${normalized}`;
}

function serviceIdForType(name) {
  if (name === "AWS Account") return "aws-iam";
  if (name.startsWith("AWS App AutoScaling ")) return "aws-application-auto-scaling";
  if (name.startsWith("AWS Cloud WAN ")) return "aws-cloud-wan";
  if (name.startsWith("AWS CloudWatch Logs ")) return "aws-cloud-watch-logs";
  if (name.startsWith("AWS Connect Customer Profiles ")) return "aws-connect-customer-profiles";
  if (name.startsWith("AWS Connect Outbound Campaigns ")) return "amazon-connect-outbound-campaigns";
  if (name.startsWith("AWS Data Pipeline ")) return "aws-data-pipeline";
  if (name.startsWith("AWS Data Sync ") || name.startsWith("AWS DataSync ")) return "aws-data-sync";
  if (name.startsWith("AWS DynamoDB Stream ")) return "aws-dynamo-db-streams";
  if (name.startsWith("AWS IAM ID ")) return "aws-iam-identity-center";
  if (name === "AWS WorkSpaces Instance" || name.startsWith("AWS WorkSpaces Instance ")) {
    return "aws-workspaces-instances";
  }
  const prefix = name.split(/\s+/u)[1];
  const serviceId = SERVICE_BY_PREFIX[prefix];
  if (serviceId === undefined) fail(`no service mapping exists for ${name}`);
  return serviceId;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

const [navigatorRaw, coverageRaw, taggableRaw] = await Promise.all([
  readFile(navigatorPath, "utf8"),
  readFile(coveragePath, "utf8"),
  readFile(taggablePath, "utf8"),
]);

const navigator = JSON.parse(navigatorRaw);
const categoryEntries = Object.entries(navigator);
if (categoryEntries.length !== 18) fail(`expected 18 categories, received ${categoryEntries.length}`);

const categories = categoryEntries.map(([name, destinations]) => {
  if (!Array.isArray(destinations) || destinations.length < 2) fail(`${name} has no service destinations`);
  const [categoryDestination, ...serviceDestinations] = destinations;
  if (categoryDestination.name !== name) fail(`${name} has a mismatched category destination`);
  return {
    id: categoryDestination.route.split("/").at(-1),
    name,
    href: categoryDestination.route,
    services: serviceDestinations.map((destination) => ({
      id: destination.route.split("/").at(-1),
      name: destination.name,
      href: destination.route,
      resourceTypes: [],
    })),
  };
});

const services = categories.flatMap((category) => category.services);
if (services.length !== 114) fail(`expected 114 services, received ${services.length}`);
const serviceById = new Map(services.map((service) => [service.id, service]));
if (serviceById.size !== services.length) fail("service identifiers are not unique");

const capturedCoverageRecords = lines(coverageRaw).filter((line) => line.startsWith("AWS "));
if (capturedCoverageRecords.length !== 978) {
  fail(`expected 978 captured coverage records, received ${capturedCoverageRecords.length}`);
}
const coverageTypes = capturedCoverageRecords.filter((line) => line !== "AWS Resource Coverage");
const taggableTypes = lines(taggableRaw);
if (coverageTypes.length !== 977) fail(`expected 977 usable coverage types, received ${coverageTypes.length}`);
if (taggableTypes.length !== 317) fail(`expected 317 taggable types, received ${taggableTypes.length}`);

const coverageSet = new Set(coverageTypes);
const taggableSet = new Set(taggableTypes);
const unionTypes = [...new Set([...coverageTypes, ...taggableTypes])].sort((left, right) => left.localeCompare(right));
const typeIds = new Set();

for (const name of unionTypes) {
  const serviceId = serviceIdForType(name);
  const service = serviceById.get(serviceId);
  if (service === undefined) fail(`${name} maps to unknown service ${serviceId}`);
  const id = slug(name);
  const scopedId = `${serviceId}/${id}`;
  if (typeIds.has(scopedId)) fail(`duplicate type identifier ${scopedId}`);
  typeIds.add(scopedId);
  service.resourceTypes.push({
    id,
    name,
    referenceCoverage: coverageSet.has(name),
    taggable: taggableSet.has(name),
  });
}

const catalog = {
  schemaVersion: "sutra.aws-cmdb-catalog.v1",
  catalogVersion: "2026-08-21",
  source: {
    navigatorCategoryCount: categories.length,
    navigatorServiceCount: services.length,
    capturedResourceCoverageRecordCount: capturedCoverageRecords.length,
    usableResourceCoverageTypeCount: coverageTypes.length,
    taggableResourceTypeCount: taggableTypes.length,
    unionResourceTypeCount: unionTypes.length,
    resourceCoverageSha256: digest(coverageRaw),
    taggableResourceTypesSha256: digest(taggableRaw),
    navigatorRoutesSha256: digest(navigatorRaw),
    anomalies: [
      "The captured resource-coverage text contains an AWS Resource Coverage page heading among the 978 AWS-prefixed records. The heading is retained in source-count provenance but excluded from usable resource types.",
      "Nine Cloud WAN types appear only in the captured Tag Analyzer inventory. They remain cataloged with referenceCoverage=false and taggable=true instead of being silently discarded.",
    ],
  },
  categories,
};

const output = `${JSON.stringify(catalog, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== output) fail("generated data is stale; run node scripts/generate-aws-cmdb-catalog.mjs");
  process.stdout.write(`AWS CMDB catalog is current (${categories.length} categories, ${services.length} services, ${unionTypes.length} resource types).\n`);
} else {
  await writeFile(outputPath, output, "utf8");
  process.stdout.write(`Generated ${outputPath} (${categories.length} categories, ${services.length} services, ${unionTypes.length} resource types).\n`);
}
