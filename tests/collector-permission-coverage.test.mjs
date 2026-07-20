import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const collectorSrc = resolve(root, "services/aws-collector/src");
const templatePath = resolve(root, "infrastructure/customer-onboarding-role.yaml");

/**
 * The definitive set of AWS SDK commands the wired collector constructs, keyed
 * by the identifier used at the `new <Command>(` call site (aliases included),
 * mapped to the IAM action it invokes.
 *
 * scope:
 *   "customer" — runs under the assumed customer onboarding role and therefore
 *                MUST be permitted by the default onboarding template.
 *   "vendor"   — runs under Sutra's own workload identity (the initial
 *                AssumeRole into the customer role) and is NOT part of the
 *                customer role's permission policy.
 *
 * Every command must be read-only. If a collector adds a new SDK command it
 * must be added here (drift guard below fails otherwise), and any new
 * "customer" action must also be granted by the template (coverage below).
 */
const COLLECTOR_COMMANDS = {
  AssumeRoleCommand: { action: "sts:AssumeRole", scope: "vendor" },
  GetCallerIdentityCommand: { action: "sts:GetCallerIdentity", scope: "customer" },
  GetRoleCommand: { action: "iam:GetRole", scope: "customer" },
  GetRolePolicyCommand: { action: "iam:GetRolePolicy", scope: "customer" },
  ListRolePoliciesCommand: { action: "iam:ListRolePolicies", scope: "customer" },
  GetAccountSummaryCommand: { action: "iam:GetAccountSummary", scope: "customer" },
  GetAccountPasswordPolicyCommand: { action: "iam:GetAccountPasswordPolicy", scope: "customer" },
  DescribeRegionsCommand: { action: "ec2:DescribeRegions", scope: "customer" },
  DescribeInstancesCommand: { action: "ec2:DescribeInstances", scope: "customer" },
  DescribeVpcsCommand: { action: "ec2:DescribeVpcs", scope: "customer" },
  DescribeSubnetsCommand: { action: "ec2:DescribeSubnets", scope: "customer" },
  DescribeSecurityGroupsCommand: { action: "ec2:DescribeSecurityGroups", scope: "customer" },
  DescribeVolumesCommand: { action: "ec2:DescribeVolumes", scope: "customer" },
  DescribeNetworkInterfacesCommand: { action: "ec2:DescribeNetworkInterfaces", scope: "customer" },
  DescribeNetworkAclsCommand: { action: "ec2:DescribeNetworkAcls", scope: "customer" },
  DescribeRouteTablesCommand: { action: "ec2:DescribeRouteTables", scope: "customer" },
  DescribeInternetGatewaysCommand: { action: "ec2:DescribeInternetGateways", scope: "customer" },
  DescribeLoadBalancersCommand: { action: "elasticloadbalancing:DescribeLoadBalancers", scope: "customer" },
  DescribeListenersCommand: { action: "elasticloadbalancing:DescribeListeners", scope: "customer" },
  DescribeTargetGroupsCommand: { action: "elasticloadbalancing:DescribeTargetGroups", scope: "customer" },
  DescribeTargetHealthCommand: { action: "elasticloadbalancing:DescribeTargetHealth", scope: "customer" },
  ListKeysCommand: { action: "kms:ListKeys", scope: "customer" },
  ListAliasesCommand: { action: "kms:ListAliases", scope: "customer" },
  DescribeKeyCommand: { action: "kms:DescribeKey", scope: "customer" },
  ListTablesCommand: { action: "dynamodb:ListTables", scope: "customer" },
  DescribeTableCommand: { action: "dynamodb:DescribeTable", scope: "customer" },
  DescribeRepositoriesCommand: { action: "ecr:DescribeRepositories", scope: "customer" },
  ListClustersCommand: { action: "eks:ListClusters", scope: "customer" },
  DescribeClusterCommand: { action: "eks:DescribeCluster", scope: "customer" },
  ListDetectorsCommand: { action: "guardduty:ListDetectors", scope: "customer" },
  GetDetectorCommand: { action: "guardduty:GetDetector", scope: "customer" },
  ListGuardDutyFindingsCommand: { action: "guardduty:ListFindings", scope: "customer" },
  GetGuardDutyFindingsCommand: { action: "guardduty:GetFindings", scope: "customer" },
  BatchGetAccountStatusCommand: { action: "inspector2:BatchGetAccountStatus", scope: "customer" },
  ListInspectorFindingsCommand: { action: "inspector2:ListFindings", scope: "customer" },
  DescribeDBInstancesCommand: { action: "rds:DescribeDBInstances", scope: "customer" },
  ListBucketsCommand: { action: "s3:ListAllMyBuckets", scope: "customer" },
  GetPublicAccessBlockCommand: { action: "s3:GetBucketPublicAccessBlock", scope: "customer" },
  DescribeHubCommand: { action: "securityhub:DescribeHub", scope: "customer" },
  GetSecurityHubFindingsCommand: { action: "securityhub:GetFindings", scope: "customer" },
  DescribeTrailsCommand: { action: "cloudtrail:DescribeTrails", scope: "customer" },
  GetTrailStatusCommand: { action: "cloudtrail:GetTrailStatus", scope: "customer" },
  LookupEventsCommand: { action: "cloudtrail:LookupEvents", scope: "customer" },
  GetCostAndUsageCommand: { action: "ce:GetCostAndUsage", scope: "customer" },
  GetCostForecastCommand: { action: "ce:GetCostForecast", scope: "customer" },
};

const READ_ONLY_VERBS =
  /^[a-z0-9-]+:(Describe|Get|List|BatchGet|LookupEvents|AssumeRole)/u;

function actionsInStatement(source, sid) {
  const marker = `- Sid: ${sid}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing statement ${sid}`);
  const following = source.indexOf("\n              - Sid:", start + marker.length);
  const block = source.slice(start, following === -1 ? source.length : following);
  return [...block.matchAll(/^\s+- ([a-z0-9*]+:[A-Za-z0-9*]+)\s*$/gmu)].map((m) => m[1]);
}

async function commandsConstructedInCollector() {
  const entries = await readdir(collectorSrc, { withFileTypes: true });
  const used = new Set();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const source = await readFile(resolve(collectorSrc, entry.name), "utf8");
    for (const match of source.matchAll(/new\s+([A-Z][A-Za-z0-9]*Command)\s*\(/gu)) {
      used.add(match[1]);
    }
  }
  return used;
}

test("every AWS command the collector constructs is mapped to a read-only action", async () => {
  const used = await commandsConstructedInCollector();
  for (const command of used) {
    assert.ok(
      Object.hasOwn(COLLECTOR_COMMANDS, command),
      `collector constructs ${command} but it is not mapped in COLLECTOR_COMMANDS; ` +
        "add its IAM action here and grant it in the onboarding template",
    );
  }
  for (const [command, { action }] of Object.entries(COLLECTOR_COMMANDS)) {
    assert.match(action, READ_ONLY_VERBS, `${command} maps to non-read-only action ${action}`);
  }
});

test("default onboarding template permits every read-only action the collector calls", async () => {
  const template = await readFile(templatePath, "utf8");

  const allowed = new Set([
    ...actionsInStatement(template, "ImplementedMetadataApis"),
    ...actionsInStatement(template, "TrustContractAttestation"),
  ]);
  const denyCeiling = new Set(actionsInStatement(template, "DenyUnimplementedActions"));

  const customerActions = [...new Set(
    Object.values(COLLECTOR_COMMANDS)
      .filter((entry) => entry.scope === "customer")
      .map((entry) => entry.action),
  )];

  for (const action of customerActions) {
    assert.ok(
      allowed.has(action),
      `collector calls ${action} but the onboarding template does not Allow it`,
    );
    // Deny uses NotAction: an action is only escaped from the Deny when it is
    // listed in NotAction. If a collector action is missing here it is denied.
    assert.ok(
      denyCeiling.has(action),
      `collector calls ${action} but the template's Deny ceiling would deny it`,
    );
  }

  // No customer action the collector relies on may be a mutation.
  for (const action of customerActions) {
    assert.match(action, READ_ONLY_VERBS, `granted collector action ${action} is not read-only`);
  }
});
