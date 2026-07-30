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
 *   "agentless" — runs under the AGENTLESS STS ceiling
 *                (agentlessSnapshotSessionPolicy) or in Sutra's own scan account.
 *                These are NOT read-only: agentless scanning creates a snapshot in
 *                the customer account by design, which is exactly why it has its own
 *                ceiling with explicit Denies on every destructive verb instead of
 *                riding on the read-only collection role. Excluded from the read-only
 *                assertion and from the onboarding template — putting them there
 *                would widen the default role EVERY customer grants, for a feature
 *                they may never enable.
 *
 * Every command must be read-only. If a collector adds a new SDK command it
 * must be added here (drift guard below fails otherwise), and any new
 * "customer" action must also be granted by the template (coverage below).
 */
const COLLECTOR_COMMANDS = {
  AssumeRoleCommand: { action: "sts:AssumeRole", scope: "vendor" },
  // Reads an agentless scan's published findings from SUTRA's OWN bucket. Vendor
  // scope, deliberately: this is never a customer permission, and putting it in the
  // onboarding template would misrepresent what Sutra asks customers to grant.
  GetObjectCommand: { action: "s3:GetObject", scope: "vendor" },
  // ─── Agentless scanning. NOT read-only, NOT in the onboarding template. ─────
  // Customer account, bounded by agentlessSnapshotSessionPolicy:
  CreateSnapshotCommand: { action: "ec2:CreateSnapshot", scope: "agentless" },
  ModifySnapshotAttributeCommand: { action: "ec2:ModifySnapshotAttribute", scope: "agentless" },
  // Sutra's own scan account, under the orchestrator role:
  CopySnapshotCommand: { action: "ec2:CopySnapshot", scope: "agentless" },
  CreateVolumeCommand: { action: "ec2:CreateVolume", scope: "agentless" },
  DeleteVolumeCommand: { action: "ec2:DeleteVolume", scope: "agentless" },
  DeleteSnapshotCommand: { action: "ec2:DeleteSnapshot", scope: "agentless" },
  RunInstancesCommand: { action: "ec2:RunInstances", scope: "agentless" },
  AttachVolumeCommand: { action: "ec2:AttachVolume", scope: "agentless" },
  TerminateInstancesCommand: { action: "ec2:TerminateInstances", scope: "agentless" },
  DescribeInstanceStatusCommand: { action: "ec2:DescribeInstanceStatus", scope: "agentless" },
  CreateTagsCommand: { action: "ec2:CreateTags", scope: "agentless" },
  GetCallerIdentityCommand: { action: "sts:GetCallerIdentity", scope: "customer" },
  GetRoleCommand: { action: "iam:GetRole", scope: "customer" },
  GetRolePolicyCommand: { action: "iam:GetRolePolicy", scope: "customer" },
  ListRolePoliciesCommand: { action: "iam:ListRolePolicies", scope: "customer" },
  ListAttachedRolePoliciesCommand: { action: "iam:ListAttachedRolePolicies", scope: "customer" },
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
  DescribeAddressesCommand: { action: "ec2:DescribeAddresses", scope: "customer" },
  DescribeFlowLogsCommand: { action: "ec2:DescribeFlowLogs", scope: "customer" },
  DescribeSnapshotsCommand: { action: "ec2:DescribeSnapshots", scope: "customer" },
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
  ListGuardrailsCommand: { action: "bedrock:ListGuardrails", scope: "customer" },
  GetGuardrailCommand: { action: "bedrock:GetGuardrail", scope: "customer" },
  GetModelInvocationLoggingConfigurationCommand: {
    action: "bedrock:GetModelInvocationLoggingConfiguration",
    scope: "customer",
  },
  GetAccountDataRetentionCommand: { action: "bedrock:GetAccountDataRetention", scope: "customer" },
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
  GetMetricDataCommand: { action: "cloudwatch:GetMetricData", scope: "customer" },
  ListMetricsCommand: { action: "cloudwatch:ListMetrics", scope: "customer" },
  DescribeInstanceInformationCommand: { action: "ssm:DescribeInstanceInformation", scope: "customer" },
  DescribeInstancePatchStatesCommand: { action: "ssm:DescribeInstancePatchStates", scope: "customer" },
  DescribeInstancePatchesCommand: { action: "ssm:DescribeInstancePatches", scope: "customer" },
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
  // The read-only claim is about COLLECTION. Agentless is excluded because it
  // genuinely writes — but not thereby unbounded: the next test pins the exact set,
  // so a new write verb cannot be slipped in under this label.
  for (const [command, { action, scope }] of Object.entries(COLLECTOR_COMMANDS)) {
    if (scope === "agentless") continue;
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

/**
 * "agentless" must not become a way to add arbitrary write verbs. Nothing labelled
 * agentless may be a verb the STS ceiling in role-broker.ts explicitly Denies, and a
 * customer-side write must be one that ceiling Allows.
 */
test("agentless write actions stay inside the STS ceiling that bounds them", async () => {
  const broker = await readFile(resolve(collectorSrc, "role-broker.ts"), "utf8");
  const listed = (name) => {
    const start = broker.indexOf(`const ${name} = [`);
    assert.ok(start !== -1, `${name} not found in role-broker.ts`);
    const block = broker.slice(start, broker.indexOf("] as const;", start));
    return [...block.matchAll(/"([a-z0-9]+:[A-Za-z0-9*]+)"/gu)].map((m) => m[1]);
  };
  const allowed = listed("SESSION_AGENTLESS_WRITE_ACTIONS");
  const denied = listed("SESSION_AGENTLESS_DENY_ACTIONS");

  const agentless = Object.entries(COLLECTOR_COMMANDS).filter(([, e]) => e.scope === "agentless");
  assert.ok(agentless.length > 0, "the agentless scope must not be empty while the feature exists");

  const matches = (pattern, action) =>
    new RegExp(`^${pattern.replaceAll(".", "\\.").replaceAll("*", ".*")}$`, "u").test(action);

  for (const [command, { action }] of agentless) {
    for (const pattern of denied) {
      // A denied verb is unreachable whatever the label claims. DeleteVolume and
      // DeleteSnapshot are exempt: they run in SUTRA's OWN account under the
      // orchestrator role, which is a different principal from the customer session
      // the deny list bounds.
      if (action === "ec2:DeleteVolume" || action === "ec2:DeleteSnapshot") continue;
      if (action === "ec2:TerminateInstances") continue;
      assert.ok(
        !matches(pattern, action),
        `${command} maps to ${action}, which SESSION_AGENTLESS_DENY_ACTIONS denies as ${pattern}`,
      );
    }
    if (action === "ec2:CreateSnapshot" || action === "ec2:ModifySnapshotAttribute") {
      assert.ok(
        allowed.some((a) => matches(a, action)),
        `${command} maps to ${action}, which the agentless STS ceiling does not allow`,
      );
    }
  }
});
