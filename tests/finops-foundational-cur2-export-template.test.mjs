import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const template = await readFile(
  new URL(
    "../infrastructure/finops-foundational-cur2-export-v1.yaml",
    import.meta.url,
  ),
  "utf8",
);
const runbook = await readFile(
  new URL(
    "../docs/finops-foundational-cur2-export.md",
    import.meta.url,
  ),
  "utf8",
);
const currentDefault = await readFile(
  new URL(
    "../infrastructure/customer-onboarding-role.yaml",
    import.meta.url,
  ),
  "utf8",
);

function resourceBlock(logicalId, nextLogicalId) {
  const start = template.indexOf(`  ${logicalId}:`);
  assert.notEqual(start, -1, `${logicalId} resource must exist`);
  const end = nextLogicalId === null
    ? template.indexOf("\nOutputs:", start)
    : template.indexOf(`\n  ${nextLogicalId}:`, start);
  assert.notEqual(end, -1, `${logicalId} resource must be bounded`);
  return template.slice(start, end);
}

const bucket = resourceBlock(
  "BillingExportBucket",
  "BillingExportBucketPolicy",
);
const bucketPolicy = resourceBlock(
  "BillingExportBucketPolicy",
  "FoundationalCur2Export",
);
const dataExport = resourceBlock(
  "FoundationalCur2Export",
  "CollectorFoundationalBillingReadPolicy",
);
const collectorPolicy = resourceBlock(
  "CollectorFoundationalBillingReadPolicy",
  null,
);

test("the add-on is versioned, native CloudFormation and blocked on the current role ceiling", () => {
  assert.match(template, /Contract: foundational-cur2-export-v1/u);
  assert.match(
    template,
    /BaseCollectorPermissionPackVersion:[\s\S]*Default: standard-2026-07\.4[\s\S]*- standard-2026-08\.1/u,
  );
  assert.match(
    template,
    /RejectCurrentReadCeiling:[\s\S]*Fn::Equals:[\s\S]*Ref: BaseCollectorPermissionPackVersion[\s\S]*standard-2026-08\.1/u,
  );
  assert.match(dataExport, /Type: AWS::BCMDataExports::Export/u);
  assert.doesNotMatch(template, /Custom::|AWS::Lambda::Function|ServiceToken/u);
  assert.doesNotMatch(template, /Type: AWS::IAM::Role/u);
  assert.match(
    template,
    /CollectorRoleName:[\s\S]*- SutraCollectorRole[\s\S]*- SutraReadOnlyRole/u,
  );
});

test("the dedicated destination is accepted or provisioned with private retained defaults", () => {
  assert.match(
    template,
    /ExistingBucketName:[\s\S]*Default: ''[\s\S]*AllowedPattern:/u,
  );
  assert.match(
    template,
    /CreateDestinationBucket:[\s\S]*Ref: ExistingBucketName[\s\S]*- ''/u,
  );
  assert.match(bucket, /Type: AWS::S3::Bucket/u);
  assert.match(bucket, /DeletionPolicy: Retain/u);
  assert.match(bucket, /UpdateReplacePolicy: Retain/u);
  assert.match(bucket, /SSEAlgorithm: AES256/u);
  assert.match(bucket, /ObjectOwnership: BucketOwnerEnforced/u);
  for (const setting of [
    "BlockPublicAcls",
    "BlockPublicPolicy",
    "IgnorePublicAcls",
    "RestrictPublicBuckets",
  ]) {
    assert.match(bucket, new RegExp(`${setting}: true`, "u"));
  }
  assert.match(bucket, /VersioningConfiguration:\s*\n\s*Status: Enabled/u);
});

test("AWS Data Exports can write only the exact account-bound export prefix", () => {
  assert.match(bucketPolicy, /Service: bcm-data-exports\.amazonaws\.com/u);
  assert.match(bucketPolicy, /Action: s3:PutObject/u);
  assert.match(
    bucketPolicy,
    /arn:\$\{AWS::Partition\}:s3:::\$\{DestinationBucket\}\/\$\{ExportPrefix\}\/\$\{ExportName\}\/\*/u,
  );
  assert.match(
    bucketPolicy,
    /aws:SourceArn:[\s\S]*arn:\$\{AWS::Partition\}:bcm-data-exports:\$\{AWS::Region\}:\$\{AWS::AccountId\}:export\/\*/u,
  );
  assert.match(
    bucketPolicy,
    /aws:SourceAccount:\s*\n\s*Ref: AWS::AccountId/u,
  );
  assert.doesNotMatch(bucketPolicy, /Principal:\s*['"]?\*['"]?/u);
  assert.doesNotMatch(bucketPolicy, /s3:GetObject|s3:DeleteObject/u);
});

test("the native export is CUR2 hourly/resource/split-cost GZIP CSV with correction history", () => {
  assert.match(
    dataExport,
    /identity_line_item_id AS line_item_id/u,
  );
  assert.match(dataExport, /FROM COST_AND_USAGE_REPORT/u);
  assert.match(
    dataExport,
    /COST_AND_USAGE_REPORT:[\s\S]*TIME_GRANULARITY: HOURLY[\s\S]*INCLUDE_RESOURCES: 'TRUE'[\s\S]*INCLUDE_SPLIT_COST_ALLOCATION_DATA: 'TRUE'/u,
  );
  assert.match(dataExport, /INCLUDE_CAPACITY_RESERVATION_DATA: 'TRUE'/u);
  assert.match(dataExport, /split_line_item_split_usage_ratio/u);
  assert.match(dataExport, /S3Prefix:\s*\n\s*Ref: ExportPrefix/u);
  assert.match(dataExport, /Compression: GZIP/u);
  assert.match(dataExport, /Format: TEXT_OR_CSV/u);
  assert.match(dataExport, /OutputType: CUSTOM/u);
  assert.match(dataExport, /Overwrite: CREATE_NEW_REPORT/u);
  assert.match(dataExport, /Frequency: SYNCHRONOUS/u);
  assert.match(
    dataExport,
    /DependsOn:\s*\n\s*- BillingExportBucketPolicy/u,
  );
});

test("the permanent collector policy contains exactly the six requested read actions", () => {
  const actions = [...collectorPolicy.matchAll(
    /^\s+(?:Action:\s*|-\s+)((?:s3|bcm-data-exports):[A-Za-z0-9*]+)\s*$/gmu,
  )].map((match) => match[1]);
  assert.deepEqual(new Set(actions), new Set([
    "s3:ListBucket",
    "s3:GetBucketLocation",
    "s3:GetObject",
    "s3:GetObjectAttributes",
    "bcm-data-exports:ListExports",
    "bcm-data-exports:GetExport",
  ]));
  assert.equal(actions.length, 6, "collector actions must not be duplicated");
  assert.match(
    collectorPolicy,
    /s3:prefix:[\s\S]*\$\{ExportPrefix\}\/\$\{ExportName\}[\s\S]*\$\{ExportPrefix\}\/\$\{ExportName\}\/\*/u,
  );
  assert.match(
    collectorPolicy,
    /ReadOnlyExactFoundationalExportObjects[\s\S]*arn:\$\{AWS::Partition\}:s3:::\$\{DestinationBucket\}\/\$\{ExportPrefix\}\/\$\{ExportName\}\/\*/u,
  );
  assert.match(
    collectorPolicy,
    /ReadOnlyThisDataExport[\s\S]*Fn::GetAtt:[\s\S]*FoundationalCur2Export[\s\S]*ExportArn/u,
  );
  assert.doesNotMatch(
    collectorPolicy,
    /CreateExport|UpdateExport|DeleteExport|PutReportDefinition|PutObject|DeleteObject|Action:\s*['"]?\*['"]?/u,
  );
});

test("the current default remains incompatible and the runbook gates publication before app release", () => {
  assert.match(currentDefault, /Value: standard-2026-07\.4/u);
  for (const action of [
    "s3:GetObject",
    "s3:GetObjectAttributes",
    "bcm-data-exports:GetExport",
    "bcm-data-exports:ListExports",
  ]) {
    assert.doesNotMatch(currentDefault, new RegExp(action, "u"));
    assert.ok(runbook.includes(`\`${action}\``));
  }
  assert.match(runbook, /Do not launch the add-on against the current `standard-2026-07\.4`/u);
  assert.match(runbook, /Publish-before-application release order/u);
  const basePublish = runbook.indexOf(
    "Publish that base template at an immutable, digest-verified URL",
  );
  const addOnPublish = runbook.indexOf(
    "publish its exact tested bytes at a separate immutable",
  );
  const appDeploy = runbook.indexOf(
    "application image that exposes the corresponding live UI/API",
  );
  assert.ok(basePublish >= 0 && addOnPublish > basePublish && appDeploy > addOnPublish);
  assert.match(runbook, /initial export delivery can take up to 24 hours/u);
  assert.match(runbook, /configuration-required or waiting state/u);
});
