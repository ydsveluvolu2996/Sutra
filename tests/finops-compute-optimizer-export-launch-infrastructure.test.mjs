import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { load as parseYaml } from "../node_modules/.pnpm/js-yaml@4.3.0/node_modules/js-yaml/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = Object.freeze({
  base: resolve(root, "infrastructure/customer-onboarding-role-standard-2026-08.4.yaml"),
  successor: resolve(root, "infrastructure/customer-onboarding-role-standard-2026-08.5.yaml"),
  addOn: resolve(root, "infrastructure/finops-compute-optimizer-export-launch-v1.yaml"),
  contract: resolve(root, "docs/finops-compute-optimizer-export-launch-v1.md"),
});

const [baseSource, successorSource, addOnSource, contract] = await Promise.all([
  readFile(paths.base, "utf8"),
  readFile(paths.successor, "utf8"),
  readFile(paths.addOn, "utf8"),
  readFile(paths.contract, "utf8"),
]);
const base = parseYaml(baseSource, { json: false });
const successor = parseYaml(successorSource, { json: false });
const addOn = parseYaml(addOnSource, { json: false });

const exportActions = Object.freeze([
  "compute-optimizer:ExportAutoScalingGroupRecommendations",
  "compute-optimizer:ExportEBSVolumeRecommendations",
  "compute-optimizer:ExportEC2InstanceRecommendations",
  "compute-optimizer:ExportECSServiceRecommendations",
  "compute-optimizer:ExportIdleRecommendations",
  "compute-optimizer:ExportLambdaFunctionRecommendations",
  "compute-optimizer:ExportLicenseRecommendations",
  "compute-optimizer:ExportRDSDatabaseRecommendations",
]);
const computeOptimizerGetActions = Object.freeze([
  "compute-optimizer:GetAutoScalingGroupRecommendations",
  "compute-optimizer:GetEBSVolumeRecommendations",
  "compute-optimizer:GetEC2InstanceRecommendations",
  "compute-optimizer:GetECSServiceRecommendations",
  "compute-optimizer:GetIdleRecommendations",
  "compute-optimizer:GetLambdaFunctionRecommendations",
  "compute-optimizer:GetLicenseRecommendations",
  "compute-optimizer:GetRDSDatabaseRecommendations",
]);
const dependencyActions = Object.freeze([
  "autoscaling:DescribeAutoScalingGroups",
  "ec2:DescribeInstances",
  "ec2:DescribeVolumes",
  "ecs:ListClusters",
  "ecs:ListServices",
  "lambda:ListFunctions",
  "lambda:ListProvisionedConcurrencyConfigs",
  "rds:DescribeDBClusters",
  "rds:DescribeDBInstances",
]);
const launchActionSet = Object.freeze([
  ...exportActions,
  ...computeOptimizerGetActions,
  ...dependencyActions,
]);
const ceilingAdditions = Object.freeze([
  ...exportActions,
  ...computeOptimizerGetActions,
  "autoscaling:DescribeAutoScalingGroups",
  "ecs:ListClusters",
  "ecs:ListServices",
  "lambda:ListFunctions",
  "lambda:ListProvisionedConcurrencyConfigs",
  "rds:DescribeDBClusters",
]);

function statements(template) {
  return template.Resources.CustomerReadRole.Properties.Policies
    .flatMap((policy) => policy.PolicyDocument.Statement);
}

function policyStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(policyStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(policyStrings);
  }
  return [];
}

test("the immutable successor and launch add-on parse as strict YAML", () => {
  assert.equal(successor.AWSTemplateFormatVersion, "2010-09-09");
  assert.equal(addOn.AWSTemplateFormatVersion, "2010-09-09");
  assert.deepEqual(Object.keys(addOn.Resources), [
    "ComputeOptimizerExportBucket",
    "ComputeOptimizerExportBucketPolicy",
    "ComputeOptimizerExportLaunchPolicy",
  ]);
});

test("standard-2026-08.4 remains byte-for-byte unchanged", () => {
  const committed = spawnSync(
    "git",
    ["show", "HEAD:infrastructure/customer-onboarding-role-standard-2026-08.4.yaml"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(baseSource, committed.stdout);
});

test("standard-2026-08.5 changes only identity and the exact launch ceiling", () => {
  const priorDeny = statements(base).find(({ Sid }) => Sid === "DenyUnimplementedActions");
  const nextDeny = statements(successor).find(({ Sid }) => Sid === "DenyUnimplementedActions");
  const additions = nextDeny.NotAction.filter((action) => !priorDeny.NotAction.includes(action));
  assert.deepEqual(additions, ceilingAdditions);
  assert.deepEqual(priorDeny.NotAction.filter((action) => !nextDeny.NotAction.includes(action)), []);
  assert.equal(new Set(nextDeny.NotAction).size, nextDeny.NotAction.length);
  for (const action of launchActionSet) assert.ok(nextDeny.NotAction.includes(action), action);

  const normalized = structuredClone(successor);
  normalized.Description = base.Description;
  normalized.Metadata = structuredClone(base.Metadata);
  const normalizedDeny = statements(normalized)
    .find(({ Sid }) => Sid === "DenyUnimplementedActions");
  normalizedDeny.NotAction = normalizedDeny.NotAction
    .filter((action) => !ceilingAdditions.includes(action));
  normalized.Resources.CustomerReadRole.Properties.Tags
    .find(({ Key }) => Key === "sutra:permission-pack").Value = "standard-2026-08.4";
  normalized.Outputs.PermissionPackVersion.Value = "standard-2026-08.4";
  delete normalized.Outputs.RequiredComputeOptimizerExportLaunchAddOn;
  assert.deepEqual(normalized, base);
});

test("the successor adds no grants while keeping object access ceiling-only", () => {
  const priorAllows = statements(base).filter(({ Effect }) => Effect === "Allow");
  const nextAllows = statements(successor).filter(({ Effect }) => Effect === "Allow");
  assert.deepEqual(nextAllows, priorAllows);
  const allows = statements(successor)
    .filter(({ Effect }) => Effect === "Allow")
    .flatMap(({ Action }) => Array.isArray(Action) ? Action : [Action]);
  for (const action of [...exportActions, ...computeOptimizerGetActions,
    "autoscaling:DescribeAutoScalingGroups", "ecs:ListClusters", "ecs:ListServices",
    "lambda:ListFunctions", "lambda:ListProvisionedConcurrencyConfigs",
    "rds:DescribeDBClusters", "s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"])
    assert.equal(allows.includes(action), false, `${action} is ceiling-only`);
  assert.equal(successor.Metadata.SutraPermissionPack.Version, "standard-2026-08.5");
  assert.equal(
    successor.Outputs.RequiredComputeOptimizerExportLaunchAddOn.Value,
    "compute-optimizer-export-launch-v1",
  );
});

test("the add-on owns a retained private versioned SSE-S3 bucket", () => {
  const bucket = addOn.Resources.ComputeOptimizerExportBucket;
  assert.equal(bucket.Type, "AWS::S3::Bucket");
  assert.equal(bucket.DeletionPolicy, "Retain");
  assert.equal(bucket.UpdateReplacePolicy, "Retain");
  assert.deepEqual(bucket.Properties.VersioningConfiguration, { Status: "Enabled" });
  assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  });
  assert.deepEqual(bucket.Properties.OwnershipControls, {
    Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
  });
  assert.deepEqual(bucket.Properties.BucketEncryption, {
    ServerSideEncryptionConfiguration: [{
      ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
      BucketKeyEnabled: false,
    }],
  });
  assert.equal(addOn.Parameters.ExistingBucketName, undefined);
  assert.equal(addOn.Parameters.KmsKeyArn, undefined);
});

test("the service principal has exactly the three required destination permissions", () => {
  const policy = addOn.Resources.ComputeOptimizerExportBucketPolicy
    .Properties.PolicyDocument;
  assert.deepEqual(policy.Statement.map(({ Sid, Action }) => ({ Sid, Action })), [
    { Sid: "AllowComputeOptimizerGetBucketAcl", Action: "s3:GetBucketAcl" },
    { Sid: "AllowComputeOptimizerGetBucketPolicyStatus", Action: "s3:GetBucketPolicyStatus" },
    { Sid: "AllowComputeOptimizerPutOnlyBelowSealedProviderPrefix", Action: "s3:PutObject" },
  ]);
  for (const statement of policy.Statement) {
    assert.deepEqual(statement.Principal, { Service: "compute-optimizer.amazonaws.com" });
    assert.equal(statement.Effect, "Allow");
  }
  const write = policy.Statement[2];
  assert.equal(
    write.Resource["Fn::Sub"],
    "${ComputeOptimizerExportBucket.Arn}/${ExportBasePrefix}compute-optimizer/${AWS::AccountId}/*",
  );
  assert.deepEqual(write.Condition, {
    StringEquals: {
      "s3:x-amz-acl": "bucket-owner-full-control",
      "aws:SourceAccount": { Ref: "AWS::AccountId" },
    },
    ArnLike: {
      "aws:SourceArn": {
        "Fn::Sub": "arn:${AWS::Partition}:compute-optimizer:${AWS::Region}:${AWS::AccountId}:*",
      },
    },
  });
});

test("the collector receives all and only the 25 launch/dependency actions", () => {
  const policy = addOn.Resources.ComputeOptimizerExportLaunchPolicy.Properties.PolicyDocument;
  const [launch, dependencies, read] = policy.Statement;
  assert.deepEqual(launch.Action, exportActions);
  assert.equal(launch.Resource, "*");
  assert.deepEqual(dependencies.Action, [...computeOptimizerGetActions, ...dependencyActions]);
  assert.equal(dependencies.Resource, "*");
  assert.deepEqual(read.Action, ["s3:GetObject", "s3:GetObjectVersion"]);
  assert.equal(
    read.Resource["Fn::Sub"],
    "${ComputeOptimizerExportBucket.Arn}/${ExportBasePrefix}compute-optimizer/${AWS::AccountId}/*",
  );
  assert.equal(new Set([...launch.Action, ...dependencies.Action]).size, 25);

  const actions = [...launch.Action, ...dependencies.Action, ...read.Action];
  for (const forbidden of [
    "compute-optimizer:UpdateEnrollmentStatus",
    "compute-optimizer:PutRecommendationPreferences",
    "compute-optimizer:DeleteRecommendationPreferences",
    "s3:ListBucket",
    "s3:ListAllMyBuckets",
    "s3:DeleteObject",
    "s3:PutObject",
    "iam:",
    "sts:",
    "kms:",
  ]) assert.doesNotMatch(actions.join("\n"), new RegExp(forbidden, "u"));
  assert.equal(actions.some((action) => action.endsWith(":*")), false);
});

test("every wildcard S3 object Allow is the same sealed provider prefix", () => {
  const resources = [
    ...policyStrings(addOn.Resources.ComputeOptimizerExportBucketPolicy.Properties.PolicyDocument),
    ...policyStrings(addOn.Resources.ComputeOptimizerExportLaunchPolicy.Properties.PolicyDocument),
  ].filter((value) => value.includes("ComputeOptimizerExportBucket.Arn") && value.includes("*"));
  assert.deepEqual(resources, [
    "${ComputeOptimizerExportBucket.Arn}/${ExportBasePrefix}compute-optimizer/${AWS::AccountId}/*",
    "${ComputeOptimizerExportBucket.Arn}/${ExportBasePrefix}compute-optimizer/${AWS::AccountId}/*",
  ]);
});

test("partition, account, and Region inputs fail closed against stack context", () => {
  assert.deepEqual(addOn.Parameters.ExpectedPartition.AllowedValues, ["aws", "aws-us-gov", "aws-cn"]);
  assert.deepEqual(
    addOn.Rules.BindExactStackContext.Assertions.map(({ Assert }) => Assert["Fn::Equals"]),
    [
      [{ Ref: "ExpectedPartition" }, { Ref: "AWS::Partition" }],
      [{ Ref: "RequesterAccountId" }, { Ref: "AWS::AccountId" }],
      [{ Ref: "ExportRegion" }, { Ref: "AWS::Region" }],
    ],
  );
  const sourceArn = addOn.Resources.ComputeOptimizerExportBucketPolicy
    .Properties.PolicyDocument.Statement[2].Condition.ArnLike["aws:SourceArn"]["Fn::Sub"];
  assert.match(sourceArn, /^arn:\$\{AWS::Partition\}:compute-optimizer:/u);
  assert.equal(addOn.Outputs.ComputeOptimizerServicePrincipal.Value, "compute-optimizer.amazonaws.com");
});

test("outputs form a complete non-secret onboarding attestation", () => {
  assert.deepEqual(Object.keys(addOn.Outputs), [
    "ContractVersion",
    "RequiredBasePermissionPackVersion",
    "CollectorRoleName",
    "CollectorRoleArn",
    "StackPartition",
    "RequesterAccountId",
    "ExportRegion",
    "ExportBucketName",
    "ExportBucketArn",
    "ExportBasePrefix",
    "EffectivePrefix",
    "ObjectArnPrefix",
    "EncryptionMode",
    "BucketVersioningStatus",
    "ComputeOptimizerServicePrincipal",
    "AttachedPolicyName",
    "BucketPolicyLogicalId",
  ]);
  assert.equal(addOn.Outputs.ContractVersion.Value, "compute-optimizer-export-launch-v1");
  assert.deepEqual(addOn.Outputs.RequiredBasePermissionPackVersion.Value, {
    Ref: "BaseCollectorPermissionPackVersion",
  });
  assert.equal(addOn.Outputs.EncryptionMode.Value, "SSE_S3");
  assert.equal(addOn.Outputs.BucketVersioningStatus.Value, "Enabled");
  assert.equal(
    addOn.Outputs.EffectivePrefix.Value["Fn::Sub"],
    "${ExportBasePrefix}compute-optimizer/${AWS::AccountId}/",
  );
  const names = Object.keys(addOn.Parameters).concat(Object.keys(addOn.Outputs)).join("\n");
  assert.doesNotMatch(names, /credential|secret|external.?id|access.?key|session.?token/iu);
});

test("the contract pins current primary AWS authorization and destination evidence", () => {
  for (const source of [
    "https://docs.aws.amazon.com/service-authorization/latest/reference/list_awscomputeoptimizer.html",
    "https://docs.aws.amazon.com/compute-optimizer/latest/ug/create-s3-bucket-policy-for-compute-optimizer.html",
    "https://docs.aws.amazon.com/compute-optimizer/latest/ug/using-encrypted-s3-buckets.html",
    "https://docs.aws.amazon.com/compute-optimizer/latest/ug/exporting-your-recommendations.html",
  ]) assert.match(contract, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(contract, /Allow in a separate[\s\S]*cannot override that explicit Deny/u);
  assert.match(contract, /has not been published, deployed/u);
  assert.match(contract, /must never accept a browser-supplied destination/u);
});

test("both new direct-upload templates remain below the CloudFormation body limit", async () => {
  for (const path of [paths.successor, paths.addOn]) {
    const metadata = await stat(path);
    assert.ok(metadata.size < 51_200, `${path} is ${metadata.size} bytes`);
  }
});
