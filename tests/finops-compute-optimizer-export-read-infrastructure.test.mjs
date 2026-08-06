import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { load as parseYaml } from "../node_modules/.pnpm/js-yaml@4.3.0/node_modules/js-yaml/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = Object.freeze({
  previous: resolve(root, "infrastructure/customer-onboarding-role-standard-2026-08.3.yaml"),
  successor: resolve(root, "infrastructure/customer-onboarding-role-standard-2026-08.4.yaml"),
  addOn: resolve(root, "infrastructure/finops-compute-optimizer-export-read-v1.yaml"),
  contract: resolve(root, "docs/finops-compute-optimizer-export-read-v1.md"),
});

const [previousSource, successorSource, addOnSource, contract] = await Promise.all([
  readFile(paths.previous, "utf8"),
  readFile(paths.successor, "utf8"),
  readFile(paths.addOn, "utf8"),
  readFile(paths.contract, "utf8"),
]);

const previous = parseYaml(previousSource, { json: false });
const successor = parseYaml(successorSource, { json: false });
const addOn = parseYaml(addOnSource, { json: false });

function baseStatements(template) {
  return template.Resources.CustomerReadRole.Properties.Policies
    .flatMap((policy) => policy.PolicyDocument.Statement);
}

function actionsFrom(statement, key = "Action") {
  const value = statement[key];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function policyStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(policyStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(policyStrings);
  }
  return [];
}

test("both candidate templates parse as strict YAML documents", () => {
  assert.equal(successor.AWSTemplateFormatVersion, "2010-09-09");
  assert.equal(addOn.AWSTemplateFormatVersion, "2010-09-09");
  assert.deepEqual(Object.keys(addOn.Resources), ["ComputeOptimizerExportObjectReadPolicy"]);
  assert.equal(addOn.Resources.ComputeOptimizerExportObjectReadPolicy.Type, "AWS::IAM::Policy");
});

test("published standard-2026-08.3 bytes remain unchanged in the worktree", () => {
  const committed = spawnSync(
    "git",
    ["show", "HEAD:infrastructure/customer-onboarding-role-standard-2026-08.3.yaml"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(previousSource, committed.stdout);
});

test("standard-2026-08.4 changes only the reviewed ceiling and honest identity", () => {
  const priorDeny = baseStatements(previous).find(({ Sid }) => Sid === "DenyUnimplementedActions");
  const nextDeny = baseStatements(successor).find(({ Sid }) => Sid === "DenyUnimplementedActions");
  const additions = nextDeny.NotAction.filter((action) => !priorDeny.NotAction.includes(action));
  assert.deepEqual(additions, ["s3:GetObjectVersion", "kms:GenerateDataKey"]);
  assert.deepEqual(priorDeny.NotAction.filter((action) => !nextDeny.NotAction.includes(action)), []);
  assert.equal(new Set(nextDeny.NotAction).size, nextDeny.NotAction.length);

  const normalized = structuredClone(successor);
  normalized.Description = previous.Description;
  normalized.Metadata = structuredClone(previous.Metadata);
  const normalizedDeny = baseStatements(normalized).find(({ Sid }) => Sid === "DenyUnimplementedActions");
  normalizedDeny.NotAction = normalizedDeny.NotAction.filter(
    (action) => action !== "s3:GetObjectVersion" && action !== "kms:GenerateDataKey",
  );
  const permissionPackTag = normalized.Resources.CustomerReadRole.Properties.Tags
    .find(({ Key }) => Key === "sutra:permission-pack");
  permissionPackTag.Value = "standard-2026-08.3";
  normalized.Outputs.PermissionPackVersion.Value = "standard-2026-08.3";
  delete normalized.Outputs.RequiredComputeOptimizerExportReadAddOn;
  assert.deepEqual(normalized, previous);
});

test("the successor base role grants no S3 object or KMS data access", () => {
  const allows = baseStatements(successor)
    .filter(({ Effect }) => Effect === "Allow")
    .flatMap((statement) => actionsFrom(statement));
  for (const forbidden of [
    "s3:GetObject",
    "s3:GetObjectVersion",
    "s3:GetObjectAttributes",
    "kms:Decrypt",
    "kms:GenerateDataKey",
  ]) {
    assert.equal(allows.includes(forbidden), false, `${forbidden} must remain ceiling-only`);
  }
  assert.equal(successor.Metadata.SutraPermissionPack.Version, "standard-2026-08.4");
  assert.equal(
    successor.Outputs.RequiredComputeOptimizerExportReadAddOn.Value,
    "compute-optimizer-export-read-v1",
  );
});

test("the add-on binds the declared partition, account, and Region to its stack", () => {
  const assertions = addOn.Rules.BindExactStackContext.Assertions;
  assert.deepEqual(assertions.map(({ Assert }) => Assert["Fn::Equals"]), [
    [{ Ref: "ExpectedPartition" }, { Ref: "AWS::Partition" }],
    [{ Ref: "RequesterAccountId" }, { Ref: "AWS::AccountId" }],
    [{ Ref: "ExportRegion" }, { Ref: "AWS::Region" }],
  ]);
  assert.deepEqual(addOn.Parameters.ExpectedPartition.AllowedValues, ["aws", "aws-us-gov", "aws-cn"]);
  assert.equal(addOn.Parameters.ExistingBucketName.Default, undefined);
  assert.equal(addOn.Parameters.ExistingBucketName.MinLength, 3);
  assert.match(addOn.Parameters.ExportBasePrefix.AllowedPattern, /\^\$\|/u);
});

test("the permanent policy grants exactly two reads on one derived provider prefix", () => {
  const policy = addOn.Resources.ComputeOptimizerExportObjectReadPolicy.Properties.PolicyDocument;
  const read = policy.Statement[0];
  assert.deepEqual(read, {
    Sid: "ReadSealedComputeOptimizerExportPrefix",
    Effect: "Allow",
    Action: ["s3:GetObject", "s3:GetObjectVersion"],
    Resource: {
      "Fn::Sub": "arn:${AWS::Partition}:s3:::${ExistingBucketName}/${ExportBasePrefix}compute-optimizer/${RequesterAccountId}/*",
    },
  });

  const policyValues = policyStrings(policy);
  const wildcardValues = policyValues.filter((value) => value.includes("*"));
  assert.deepEqual(wildcardValues, [
    "arn:${AWS::Partition}:s3:::${ExistingBucketName}/${ExportBasePrefix}compute-optimizer/${RequesterAccountId}/*",
  ]);
  assert.equal(wildcardValues[0].endsWith("/${RequesterAccountId}/*"), true);

  const actions = policy.Statement.flatMap((statement) => {
    const resolved = statement["Fn::If"]?.[1] ?? statement;
    return actionsFrom(resolved);
  });
  assert.deepEqual(actions, [
    "s3:GetObject",
    "s3:GetObjectVersion",
    "kms:Decrypt",
    "kms:GenerateDataKey",
  ]);
  assert.equal(new Set(actions).size, actions.length);
  for (const forbidden of [
    "ListBucket",
    "GetBucketLocation",
    "GetObjectAttributes",
    "PutObject",
    "DeleteObject",
    "Export",
  ]) {
    assert.doesNotMatch(actions.join("\n"), new RegExp(forbidden, "u"));
  }
  assert.equal(
    Object.values(addOn.Resources).some(({ Type }) => Type === "AWS::S3::Bucket"),
    false,
  );
});

test("KMS mode is optional and exact-key use is restricted to regional S3", () => {
  const conditional = addOn.Resources.ComputeOptimizerExportObjectReadPolicy
    .Properties.PolicyDocument.Statement[1]["Fn::If"];
  assert.equal(conditional[0], "HasCustomerManagedKmsKey");
  assert.deepEqual(conditional[1], {
    Sid: "UseExactExportKeyThroughRegionalS3",
    Effect: "Allow",
    Action: ["kms:Decrypt", "kms:GenerateDataKey"],
    Resource: { Ref: "ExistingBucketKmsKeyArn" },
    Condition: {
      StringEquals: {
        "kms:ViaService": { "Fn::Sub": "s3.${AWS::Region}.amazonaws.com" },
      },
    },
  });
  assert.deepEqual(conditional[2], { Ref: "AWS::NoValue" });
  assert.equal(addOn.Conditions.HasCustomerManagedKmsKey["Fn::Not"] !== undefined, true);
  assert.match(addOn.Parameters.ExistingBucketKmsKeyArn.AllowedPattern, /:key\//u);
  assert.doesNotMatch(addOn.Parameters.ExistingBucketKmsKeyArn.AllowedPattern, /alias/u);
  assert.match(
    addOn.Parameters.ExistingBucketKmsKeyContract.AllowedValues[1],
    /symmetric-customer-managed-same-partition-account-region/u,
  );
});

test("partition-safe ARNs and deterministic outputs fully attest the add-on", () => {
  const outputs = addOn.Outputs;
  assert.deepEqual(Object.keys(outputs), [
    "ContractVersion",
    "RequiredBasePermissionPackVersion",
    "CollectorRoleName",
    "CollectorRoleArn",
    "StackPartition",
    "RequesterAccountId",
    "ExportRegion",
    "ExistingBucketName",
    "ExportBasePrefix",
    "EffectivePrefix",
    "ObjectArnPrefix",
    "KmsMode",
    "KmsKeyArn",
    "AttachedPolicyName",
  ]);
  assert.equal(outputs.ContractVersion.Value, "compute-optimizer-export-read-v1");
  assert.deepEqual(outputs.RequiredBasePermissionPackVersion.Value, {
    Ref: "BaseCollectorPermissionPackVersion",
  });
  assert.equal(
    outputs.CollectorRoleArn.Value["Fn::Sub"],
    "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/sutra/${CollectorRoleName}",
  );
  assert.equal(
    outputs.EffectivePrefix.Value["Fn::Sub"],
    "${ExportBasePrefix}compute-optimizer/${RequesterAccountId}/",
  );
  assert.match(outputs.ObjectArnPrefix.Value["Fn::Sub"], /^arn:\$\{AWS::Partition\}:s3:::/u);
  assert.deepEqual(outputs.KmsMode.Value["Fn::If"], ["HasCustomerManagedKmsKey", "SSE_KMS", "SSE_S3"]);
});

test("the contract pins primary AWS evidence and the one-stack-per-Region rule", () => {
  for (const source of [
    "https://docs.aws.amazon.com/compute-optimizer/latest/ug/exporting-recommendations.html",
    "https://docs.aws.amazon.com/compute-optimizer/latest/ug/using-encrypted-s3-buckets.html",
    "https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html",
    "https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html",
    "https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html#conditions-kms-via-service",
    "https://docs.aws.amazon.com/compute-optimizer/latest/ug/exporting-your-recommendations.html",
  ]) {
    assert.ok(contract.includes(source), `contract cites ${source}`);
  }
  assert.match(contract, /intersection of the role's identity policy and the session policy/u);
  assert.match(contract, /one add-on is required per Region/u);
  assert.match(contract, /has not been published, deployed/u);
});

test("both direct-upload templates remain below the CloudFormation body limit", async () => {
  for (const path of [paths.successor, paths.addOn]) {
    const metadata = await stat(path);
    assert.ok(metadata.size < 51_200, `${path} is ${metadata.size} bytes`);
  }
});
