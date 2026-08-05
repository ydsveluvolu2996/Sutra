import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import {
  AWS_CUSTOMER_ROLE_TEMPLATE_SHA256,
  AWS_CUSTOMER_ROLE_TEMPLATE_VERSION,
} from "../lib/aws-template-contract.ts";

const root = resolve(import.meta.dirname, "..");

function statementActions(source, sid) {
  const marker = `- Sid: ${sid}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, sid);
  const following = source.indexOf("\n              - Sid:", start + marker.length);
  const block = source.slice(start, following === -1 ? source.length : following);
  // Service prefixes may contain hyphens (bcm-data-exports, compute-optimizer),
  // so a hyphen-free prefix class would silently drop those actions and make the
  // deny-ceiling comparison below pass while ignoring real grants.
  return [...block.matchAll(/^\s+- ([a-z0-9*-]+:[A-Za-z0-9*]+)\s*$/gmu)]
    .map((match) => match[1]);
}

const ACTION_ITEM = /^\s+- ([a-z0-9-]+:[A-Za-z0-9*]+)\s*$/u;

/**
 * Every IAM statement in the template as `{ sid, effect, actions }`, scanned
 * line by line so no YAML dependency is needed and so conditional policies
 * (`Fn::If`) are read exactly like unconditional ones.
 *
 * Statement boundaries are `Sid:` lines at any indent, which is sound because
 * every statement in these templates declares a Sid.
 */
function statements(source) {
  const parsed = [];
  let current = null;
  let collecting = false;
  for (const line of source.split("\n")) {
    const sid = /^\s+- Sid: (\S+)\s*$/u.exec(line);
    if (sid !== null) {
      current = { sid: sid[1], effect: null, actions: [] };
      parsed.push(current);
      collecting = false;
      continue;
    }
    if (current === null) continue;
    const effect = /^\s+Effect: (Allow|Deny)\s*$/u.exec(line);
    if (effect !== null) {
      current.effect = effect[1];
      continue;
    }
    if (/^\s+(?:Not)?Action:\s*$/u.test(line)) {
      collecting = true;
      continue;
    }
    const action = ACTION_ITEM.exec(line);
    if (collecting && action !== null) current.actions.push(action[1]);
    else if (action === null && line.trim() !== "") collecting = false;
  }
  return parsed;
}

/** Actions the template actually grants, mapped to the granting statement. */
function allowedActions(source) {
  const grants = new Map();
  for (const statement of statements(source)) {
    if (statement.effect !== "Allow") continue;
    for (const action of statement.actions) grants.set(action, statement.sid);
  }
  return grants;
}

/**
 * The `NotAction` set of the explicit deny ceiling. An explicit Deny overrides
 * every Allow, so an action absent from this set is dead however it is granted.
 */
function denyCeiling(source) {
  const ceiling = statements(source)
    .find((statement) => statement.sid === "DenyUnimplementedActions");
  assert.notEqual(ceiling, undefined, "template has no DenyUnimplementedActions ceiling");
  assert.equal(ceiling.effect, "Deny");
  return new Set(ceiling.actions);
}

test("standard customer onboarding role is the reviewed public artifact", async () => {
  const infrastructure = await readFile(
    resolve(root, "infrastructure/customer-onboarding-role.yaml"),
    "utf8",
  );
  const publicArtifact = await readFile(
    resolve(root, "public/sutra-customer-onboarding-role.yaml"),
    "utf8",
  );

  assert.equal(publicArtifact, infrastructure);
  assert.equal(
    createHash("sha256").update(infrastructure, "utf8").digest("hex"),
    AWS_CUSTOMER_ROLE_TEMPLATE_SHA256,
  );
  assert.equal(AWS_CUSTOMER_ROLE_TEMPLATE_VERSION, "standard-2026-08.12");
  for (const action of [
    "ec2:DescribeRegions",
    "ec2:DescribeInstances",
    "ec2:DescribeVpcs",
    "ec2:DescribeSubnets",
    "ec2:DescribeSecurityGroups",
    "ec2:DescribeVolumes",
    "ec2:DescribeNetworkInterfaces",
    "ec2:DescribeNetworkAcls",
    "ec2:DescribeRouteTables",
    "ec2:DescribeInternetGateways",
    "ec2:DescribeAddresses",
    "ec2:DescribeSnapshots",
    // Flow-log configuration, added in permission pack standard-2026-07.3.
    "ec2:DescribeFlowLogs",
    "elasticloadbalancing:DescribeLoadBalancers",
    "elasticloadbalancing:DescribeListeners",
    "elasticloadbalancing:DescribeTargetGroups",
    "elasticloadbalancing:DescribeTargetHealth",
    "kms:ListKeys",
    "kms:ListAliases",
    "kms:DescribeKey",
    "dynamodb:ListTables",
    "dynamodb:DescribeTable",
    "ecr:DescribeRepositories",
    "s3:ListAllMyBuckets",
    "s3:GetBucketPublicAccessBlock",
    "rds:DescribeDBInstances",
    "iam:GetAccountSummary",
    "iam:GetAccountPasswordPolicy",
    "iam:GetRole",
    "iam:ListRolePolicies",
    "iam:GetRolePolicy",
    "cloudtrail:DescribeTrails",
    "cloudtrail:GetTrailStatus",
    "cloudtrail:LookupEvents",
    "guardduty:ListDetectors",
    "guardduty:GetDetector",
    "guardduty:ListFindings",
    "guardduty:GetFindings",
    "securityhub:DescribeHub",
    "securityhub:GetFindings",
    "inspector2:BatchGetAccountStatus",
    "inspector2:ListFindings",
    "bedrock:ListGuardrails",
    "bedrock:GetGuardrail",
    "bedrock:GetModelInvocationLoggingConfiguration",
    "bedrock:GetAccountDataRetention",
    "ce:GetCostAndUsage",
    "ce:GetCostForecast",
    "ssm:DescribeInstanceInformation",
    "ssm:DescribeInstancePatchStates",
    "ssm:DescribeInstancePatches",
  ]) {
    assert.match(infrastructure, new RegExp(`- ${action.replaceAll("*", "\\*")}`));
  }

  // Appearing in the deny ceiling's NotAction is NOT a grant — it is the only
  // way a separately-owned add-on policy (the CUR 2.0 export reader, the Compute
  // Optimizer export-object reader) can function at all under an explicit deny
  // that overrides every allow. So these actions are checked against what the
  // template GRANTS, not against its source text; a textual check would either
  // fail on the ceiling or, worse, be silently satisfied by a grant the ceiling
  // happens to list.
  const granted = allowedActions(infrastructure);
  for (const forbidden of [
    "s3:GetObject",
    "s3:GetObjectVersion",
    "secretsmanager:GetSecretValue",
    "ssm:GetParameter",
    "kms:Decrypt",
    "kms:GenerateDataKey",
    "iam:PassRole",
    "ec2:RunInstances",
  ]) {
    assert.equal(
      granted.has(forbidden),
      false,
      `${forbidden} is granted by ${granted.get(forbidden)}`,
    );
  }
  assert.doesNotMatch(infrastructure, /Principal:\s*['"]?\*['"]?/u);
  // No statement may grant a wildcard action or a whole-service wildcard.
  for (const [action, sid] of granted) {
    assert.doesNotMatch(action, /\*/u, `${sid} grants the wildcard action ${action}`);
  }
  assert.match(infrastructure, /sts:ExternalId:/);
  assert.doesNotMatch(infrastructure, /NoEcho:\s*true/u);
  assert.match(infrastructure, /sts:RoleSessionName:/);
  // Both names stay permitted: new stacks default to SutraCollectorRole, and the
  // pre-rename SutraReadOnlyRole must remain valid so existing customers are
  // never forced to replace a role and change its ARN.
  assert.match(infrastructure, /AllowedValues:\s*\n\s*- SutraCollectorRole\s*\n\s*- SutraReadOnlyRole/u);
  assert.match(infrastructure, /Path: \/sutra\//u);
  assert.match(infrastructure, /Sid: TrustContractAttestation/u);
  assert.match(infrastructure, /Sid: DenyUnimplementedActions[\s\S]+Effect: Deny[\s\S]+NotAction:/u);
  assert.match(infrastructure, /sutra:permission-pack[\s\S]+standard-2026-08\.12/u);
  assert.match(infrastructure, /PermissionPackVersion:[\s\S]+standard-2026-08\.12/u);

  // The ceiling is an explicit Deny with NotAction, so every granted action must
  // appear in it or the grant is dead on arrival. This is the invariant that
  // makes adding a FinOps policy safe: forget the ceiling entry and the test
  // fails rather than the customer's collection silently returning nothing.
  const ceiling = denyCeiling(infrastructure);
  const dead = [...granted].filter(([action]) => !ceiling.has(action));
  assert.deepEqual(
    dead,
    [],
    `granted but denied by the ceiling: ${dead.map(([a, sid]) => `${a} (${sid})`).join(", ")}`,
  );

  // The reverse containment does not hold, and must not be asserted: the ceiling
  // is deliberately wider than the inline grants so separately-owned add-on
  // policies can function. Those extra entries are enumerated exactly, so a new
  // one cannot be slipped in without review.
  const ceilingOnly = [...ceiling].filter((action) => !granted.has(action)).sort();
  assert.deepEqual(ceilingOnly, [
    "bcm-data-exports:GetExport",
    "bcm-data-exports:ListExports",
    "compute-optimizer:ExportAutoScalingGroupRecommendations",
    "compute-optimizer:ExportEBSVolumeRecommendations",
    "compute-optimizer:ExportEC2InstanceRecommendations",
    "compute-optimizer:ExportECSServiceRecommendations",
    "compute-optimizer:ExportIdleRecommendations",
    "compute-optimizer:ExportLambdaFunctionRecommendations",
    "compute-optimizer:ExportLicenseRecommendations",
    "compute-optimizer:ExportRDSDatabaseRecommendations",
    "compute-optimizer:GetEBSVolumeRecommendations",
    "compute-optimizer:GetECSServiceRecommendations",
    "compute-optimizer:GetIdleRecommendations",
    "compute-optimizer:GetLambdaFunctionRecommendations",
    "compute-optimizer:GetLicenseRecommendations",
    "ecs:ListClusters",
    "ecs:ListServices",
    "kms:Decrypt",
    "kms:GenerateDataKey",
    "lambda:ListFunctions",
    "lambda:ListProvisionedConcurrencyConfigs",
    "s3:GetBucketLocation",
    "s3:GetObject",
    "s3:GetObjectAttributes",
    "s3:GetObjectVersion",
    "s3:ListBucket",
  ]);

  const implemented = statementActions(infrastructure, "ImplementedMetadataApis");
  assert.equal(implemented.includes("lambda:ListFunctions"), false);
});

test("the onboarding template creates from the five-parameter quick-create link", async () => {
  // lib/aws-cloudformation-quick-launch.ts passes exactly five parameters. A
  // parameter without a default that is not in that set makes every quick-create
  // stack fail with "Parameters must have values", so onboarding would break for
  // every new customer while every local test still passed.
  const infrastructure = await readFile(
    resolve(root, "infrastructure/customer-onboarding-role.yaml"),
    "utf8",
  );
  const supplied = new Set([
    "VendorCollectorRoleArn",
    "ExternalId",
    "SessionNamePrefix",
    "CustomerTenantId",
    "RoleName",
  ]);

  const block = infrastructure.slice(
    infrastructure.indexOf("\nParameters:"),
    infrastructure.indexOf("\nConditions:"),
  );
  const declared = [...block.matchAll(/^ {2}([A-Za-z0-9]+):$/gmu)].map((match) => match[1]);
  assert.ok(declared.length >= supplied.size);

  for (const name of declared) {
    if (supplied.has(name)) continue;
    const start = block.indexOf(`\n  ${name}:`);
    const next = declared
      .map((other) => block.indexOf(`\n  ${other}:`))
      .filter((index) => index > start);
    const body = block.slice(start, next.length === 0 ? block.length : Math.min(...next));
    assert.match(
      body,
      /^\s+Default:/mu,
      `${name} has no default, so the five-parameter quick-create link cannot create this stack`,
    );
  }

  // The DCF Step Functions policy is the one grant that cannot be unconditional:
  // an empty CommaDelimitedList resolves to [''], which is not a usable IAM
  // Resource, so the policy is attached only when real ARNs are supplied.
  assert.match(infrastructure, /HasDcfStateMachines:\s*\n\s+Fn::Not:/u);
  assert.match(
    infrastructure,
    /- Fn::If:\s*\n\s+- HasDcfStateMachines\s*\n\s+- PolicyName: SutraFinopsDcfStepFunctionsReadV1/u,
  );
  assert.match(infrastructure, /- Ref: AWS::NoValue/u);
});

test("the onboarding template grants the FinOps source contracts it advertises", async () => {
  // The previous onboarding template pinned standard-2026-07.4 and contained the
  // string "finops" zero times, so every FinOps dashboard was starved at the
  // source no matter which permission pack the tracker claimed.
  const infrastructure = await readFile(
    resolve(root, "infrastructure/customer-onboarding-role.yaml"),
    "utf8",
  );
  const granted = allowedActions(infrastructure);

  assert.match(
    infrastructure,
    /AdvancedFinopsSources: cost-anomaly-v1,trusted-advisor-standard-v1,organizations-taxonomy-v1,compute-optimizer-export-discovery-v1,extended-support-projection-v1,support-cases-radar-v1,health-events-v1,resilience-vue-v1,data-collection-monitor-v1,end-user-computing-v1,graviton-savings-v1/u,
  );
  assert.match(infrastructure, /FoundationalFinopsAddOn: foundational-cur2-export-v1/u);

  for (const policy of [
    "SutraFinopsCostAnomalyReadV1",
    "SutraFinopsTrustedAdvisorStandardReadV1",
    "SutraFinopsOrganizationsTaxonomyReadV1",
    "SutraFinopsComputeOptimizerExportReadV1",
    "SutraFinopsExtendedSupportProjectionReadV1",
    "SutraFinopsSupportCasesReadV1",
    "SutraFinopsHealthOrganizationReadV1",
    "SutraFinopsResilienceVueReadV1",
    "SutraFinopsDcfStepFunctionsReadV1",
    "SutraFinopsEndUserComputingReadV1",
    "SutraFinopsGravitonSavingsReadV1",
  ]) {
    assert.match(infrastructure, new RegExp(`PolicyName: ${policy}`, "u"));
  }

  // One representative action per source contract, so a policy renamed without
  // its grants surviving still fails.
  for (const action of [
    "ce:GetAnomalies",
    "support:DescribeTrustedAdvisorChecks",
    "organizations:ListAccounts",
    "compute-optimizer:GetEnrollmentStatus",
    "rds:DescribeDBMajorEngineVersions",
    "support:DescribeCases",
    "health:DescribeEventsForOrganization",
    "resiliencehub:ListAppAssessments",
    "states:DescribeStateMachine",
    "workspaces:DescribeWorkspaces",
    "pricing:GetPriceListFileUrl",
  ]) {
    assert.equal(granted.has(action), true, `${action} is not granted`);
  }
});

test("public customer role advertises the enterprise permission-pack version", async () => {
  const publicRole = await readFile(
    resolve(root, "public/sutra-customer-role.yaml"),
    "utf8",
  );

  assert.match(publicRole, /TemplateVersion:\s*\n\s+Value: standard-2026-07\.4/u);
  assert.doesNotMatch(publicRole, /local-pilot|sandbox/u);
});

test("local collector role can assume only dedicated roles in the Sutra IAM namespace", async () => {
  const template = await readFile(
    resolve(root, "infrastructure/local-collector-role.yaml"),
    "utf8",
  );
  const hostedTemplate = await readFile(
    resolve(root, "deploy/ec2/cloudformation-single-node.yaml"),
    "utf8",
  );
  const boundary = JSON.parse(await readFile(
    resolve(root, "infrastructure/sutra-collector-boundary-policy.json"),
    "utf8",
  ));

  assert.match(template, /Action: sts:AssumeRole/);
  assert.match(
    template,
    /NotResource:\s*\n\s*Fn::Sub: arn:\$\{AWS::Partition\}:iam::\*:role\/sutra\/\*/u,
  );
  assert.match(
    template,
    /Resource:\s*\n\s*Fn::Sub: arn:\$\{AWS::Partition\}:iam::\*:role\/sutra\/\*/u,
  );
  assert.doesNotMatch(template, /CustomerRoleName/u);
  assert.doesNotMatch(template, /Action:\s*['"]?\*['"]?/);
  assert.doesNotMatch(template, /Principal:\s*['"]?\*['"]?/);
  assert.doesNotMatch(template, /AccessKey/);
  assert.match(
    template,
    /PermissionsBoundary:\s*\n\s*Fn::Sub: arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:policy\/SutraCollectorBoundary/u,
  );
  assert.doesNotMatch(template, /ManagedPolicyArns/u);
  assert.deepEqual(boundary, {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyEveryNonAssumeRoleAction",
        Effect: "Deny",
        NotAction: "sts:AssumeRole",
        Resource: "*",
      },
      {
        Sid: "DenyAssumeRoleOutsideSutraRoleNamespace",
        Effect: "Deny",
        Action: "sts:AssumeRole",
        NotResource: "arn:aws:iam::*:role/sutra/*",
      },
      {
        Sid: "AssumeDedicatedSutraCustomerRolesOnly",
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Resource: "arn:aws:iam::*:role/sutra/*",
      },
    ],
  });

  const allowedResource = boundary.Statement[2].Resource;
  const namespacePattern = new RegExp(
    `^${allowedResource.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\\\*/gu, ".*")}$`,
    "u",
  );
  assert.equal(
    namespacePattern.test("arn:aws:iam::123456789012:role/sutra/CustomerSecurityCollector"),
    true,
  );
  assert.equal(
    namespacePattern.test("arn:aws:iam::123456789012:role/sutra/acme/security/ReadOnlyCollector"),
    true,
  );
  assert.equal(
    namespacePattern.test("arn:aws:iam::123456789012:role/AdministratorAccess"),
    false,
  );
  assert.equal(
    namespacePattern.test("arn:aws:iam::123456789012:role/operations/SharedCollector"),
    false,
  );
  assert.equal(
    namespacePattern.test("arn:aws:iam::123456789012:role/sutrax/LookalikeCollector"),
    false,
  );

  for (const sourceTemplate of [template, hostedTemplate]) {
    assert.match(sourceTemplate, /Sid: DenyAssumeRoleOutsideSutraRoleNamespace/u);
    assert.match(sourceTemplate, /Sid: AssumeDedicatedSutraCustomerRolesOnly/u);
    assert.match(sourceTemplate, /arn:\$\{AWS::Partition\}:iam::\*:role\/sutra\/\*/u);
    assert.doesNotMatch(sourceTemplate, /arn:\$\{AWS::Partition\}:iam::\*:role\/\*(?:\s|$)/u);
    assert.doesNotMatch(sourceTemplate, /role\/AdministratorAccess/u);
  }
});

test("SutraOperator permission-set policy is the exact account-scoped live contract", async () => {
  const path = resolve(root, "infrastructure/sutra-operator-permission-set-policy.json");
  const source = await readFile(path, "utf8");
  const policy = JSON.parse(source);
  assert.equal(
    createHash("sha256").update(source, "utf8").digest("hex"),
    "7fe1024f4ec6caffe6e4de75e082d78e032c25ac6c9e7925741a3927aa9c8f7c",
  );
  assert.equal(policy.Version, "2012-10-17");
  assert.ok(Array.isArray(policy.Statement));
  const statements = new Map(policy.Statement.map((statement) => [statement.Sid, statement]));
  assert.deepEqual(
    new Set(statements.get("AttestExactCollectorRolePolicies")?.Action),
    new Set(["iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListRolePolicies"]),
  );
  assert.equal(
    statements.get("AttestExactCollectorRolePolicies")?.Resource,
    "arn:aws:iam::505060607080:role/sutra/SutraLocalCollectorRole",
  );
  assert.deepEqual(
    new Set(statements.get("ConfigureAndRecoverExactTemplateBucket")?.Action),
    new Set([
      "s3:GetBucketTagging",
      "s3:ListBucket",
      "s3:ListBucketVersions",
      "s3:PutBucketOwnershipControls",
      "s3:PutBucketPolicy",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketTagging",
      "s3:PutBucketVersioning",
      "s3:PutEncryptionConfiguration",
    ]),
  );
  assert.equal(
    statements.get("PublishExactReviewedTemplateObject")?.Resource,
    // DERIVED from the contract constants, not duplicated. This key was hardcoded
    // and had already drifted to a hash matching no template in the repo, which
    // scoped the operator role to publish an object name the build never produces
    // — the reason the published template URLs 404. Deriving it makes the operator
    // policy and the artifact it is allowed to publish impossible to desync.
    `arn:aws:s3:::sutra-onboarding-505060607080-us-east-1/templates/`
      + `${AWS_CUSTOMER_ROLE_TEMPLATE_VERSION}/${AWS_CUSTOMER_ROLE_TEMPLATE_SHA256}.yaml`,
  );
  assert.equal(
    statements.get("CreateReviewedCollectorChangeSet")?.Condition?.StringEquals?.[
      "aws:RequestTag/sutra:template-sha256"
    ],
    "571c9004cfd8816509b74f3b41ae3d2cf9708a7b8a7f61097ed3b76dccf0b58e",
  );
  const serialized = JSON.stringify(policy);
  for (const forbidden of [
    '"Action":"*"',
    "iam:AttachRolePolicy",
    "iam:CreatePolicy",
    "iam:CreatePolicyVersion",
    "iam:DeleteRolePermissionsBoundary",
    "iam:PassRole",
    "iam:SetDefaultPolicyVersion",
    "s3:GetObject",
    "s3:DeleteObject",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
