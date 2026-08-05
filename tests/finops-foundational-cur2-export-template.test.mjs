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
const immutableBaseline = await readFile(
  new URL(
    "../infrastructure/customer-onboarding-role-standard-2026-07.4.yaml",
    import.meta.url,
  ),
  "utf8",
);

// The seven reads this add-on needs. They must be permitted by the base role's
// DenyUnimplementedActions ceiling — otherwise a scoped Allow here cannot take
// effect — while never being granted by the base role itself. Splitting the
// ceiling from the rest of the template is what lets one assertion distinguish
// "permitted" from "granted"; a whole-file string match cannot.
const ADD_ON_EXPORT_READS = [
  "s3:ListBucket",
  "s3:GetBucketLocation",
  "s3:GetObject",
  "s3:GetObjectAttributes",
  "kms:Decrypt",
  "bcm-data-exports:ListExports",
  "bcm-data-exports:GetExport",
];

function splitDenyCeiling(templateText) {
  const lines = templateText.split("\n");
  const sid = lines.findIndex((line) =>
    /^\s*-\s*Sid:\s*DenyUnimplementedActions\s*$/u.test(line),
  );
  assert.ok(sid >= 0, "the base role must carry a DenyUnimplementedActions ceiling");
  const listStart = lines.findIndex(
    (line, index) => index > sid && /^\s*NotAction:\s*$/u.test(line),
  );
  assert.ok(listStart > sid, "the ceiling must be expressed as a NotAction allowlist");
  const indent = lines[listStart].search(/\S/u);
  let end = listStart + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() !== "" && line.search(/\S/u) <= indent) break;
    end += 1;
  }
  return {
    ceiling: lines.slice(listStart, end).join("\n"),
    rest: [...lines.slice(0, listStart), ...lines.slice(end)].join("\n"),
  };
}

function resourceBlock(logicalId, nextLogicalId) {
  const start = template.indexOf(`  ${logicalId}:`);
  assert.notEqual(start, -1, `${logicalId} resource must exist`);
  const end = nextLogicalId === null
    ? template.indexOf("\nOutputs:", start)
    : template.indexOf(`\n  ${nextLogicalId}:`, start);
  assert.notEqual(end, -1, `${logicalId} resource must be bounded`);
  return template.slice(start, end);
}

const key = resourceBlock(
  "BillingExportKey",
  "BillingExportBucket",
);
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
  assert.match(
    template,
    /ExistingBucketContract:[\s\S]*dedicated-private-retained-cmk/u,
  );
  assert.match(
    template,
    /ExistingBucketKmsKeyArn:[\s\S]*AllowedPattern:[^\n]*:kms:/u,
  );
  assert.match(
    template,
    /ExistingBucketMeetsDestinationContract:[\s\S]*Ref: ExistingBucketKmsKeyArn[\s\S]*- ''/u,
  );
  assert.match(key, /Type: AWS::KMS::Key/u);
  assert.match(key, /Condition: CreateDestinationBucket/u);
  assert.match(key, /DeletionPolicy: Retain/u);
  assert.match(key, /UpdateReplacePolicy: Retain/u);
  assert.match(key, /EnableKeyRotation: true/u);
  assert.match(key, /KeySpec: SYMMETRIC_DEFAULT/u);
  assert.match(bucket, /Type: AWS::S3::Bucket/u);
  assert.match(bucket, /DeletionPolicy: Retain/u);
  assert.match(bucket, /UpdateReplacePolicy: Retain/u);
  assert.match(bucket, /SSEAlgorithm: aws:kms/u);
  assert.match(
    bucket,
    /KMSMasterKeyID:[\s\S]*Fn::GetAtt:[\s\S]*BillingExportKey[\s\S]*Arn/u,
  );
  assert.doesNotMatch(bucket, /SSEAlgorithm: AES256|alias\/aws\/s3/u);
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

test("the created CMK permits only account-bound Data Exports encryption through S3", () => {
  const deliveryStatement = key.slice(
    key.indexOf("- Sid: AllowAccountBoundDataExportsEncryption"),
  );
  const actions = [...deliveryStatement.matchAll(
    /^\s+- (kms:[A-Za-z0-9*]+)\s*$/gmu,
  )].map((match) => match[1]);
  assert.deepEqual(actions, ["kms:GenerateDataKey", "kms:Decrypt"]);
  assert.match(deliveryStatement, /Service: bcm-data-exports\.amazonaws\.com/u);
  assert.match(
    deliveryStatement,
    /aws:SourceArn:[\s\S]*arn:\$\{AWS::Partition\}:bcm-data-exports:\$\{AWS::Region\}:\$\{AWS::AccountId\}:export\/\$\{ExportName\}-\*/u,
  );
  assert.match(
    deliveryStatement,
    /aws:SourceAccount:\s*\n\s*Ref: AWS::AccountId/u,
  );
  assert.match(
    deliveryStatement,
    /kms:ViaService:[\s\S]*s3\.\$\{AWS::Region\}\.\$\{AWS::URLSuffix\}/u,
  );
  assert.match(
    deliveryStatement,
    /kms:EncryptionContext:aws:s3:arn:/u,
  );
  assert.doesNotMatch(
    deliveryStatement,
    /kms:(?:Encrypt|ReEncrypt\w*|CreateGrant)(?:\s|$)|Principal:\s*['"]?\*['"]?/u,
  );
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

test("the permanent collector policy contains only the exact seven requested read actions", () => {
  const actions = [...collectorPolicy.matchAll(
    /^\s+(?:Action:\s*|-\s+)((?:s3|kms|bcm-data-exports):[A-Za-z0-9*]+)\s*$/gmu,
  )].map((match) => match[1]);
  assert.deepEqual(new Set(actions), new Set([
    "s3:ListBucket",
    "s3:GetBucketLocation",
    "s3:GetObject",
    "s3:GetObjectAttributes",
    "kms:Decrypt",
    "bcm-data-exports:ListExports",
    "bcm-data-exports:GetExport",
  ]));
  assert.equal(actions.length, 7, "collector actions must not be duplicated");
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
  assert.match(
    collectorPolicy,
    /DecryptOnlyExactFoundationalExportObjects[\s\S]*Action: kms:Decrypt[\s\S]*BillingExportKey[\s\S]*ExistingBucketKmsKeyArn[\s\S]*kms:ViaService:[\s\S]*s3\.\$\{DestinationBucketRegion\}\.\$\{AWS::URLSuffix\}[\s\S]*kms:EncryptionContext:aws:s3:arn:[\s\S]*\$\{ExportPrefix\}\/\$\{ExportName\}\/\*/u,
  );
  assert.doesNotMatch(
    collectorPolicy,
    /CreateExport|UpdateExport|DeleteExport|PutReportDefinition|PutObject|DeleteObject|kms:(?:Encrypt|GenerateDataKey|ReEncrypt\w*|CreateGrant)(?:\s|$)|Action:\s*['"]?\*['"]?/u,
  );
});

test("the deployable default permits the add-on's reads without granting them, and the runbook gates publication before app release", () => {
  // The default advanced to standard-2026-08.12 so the FinOps verticals are not
  // starved at the source. The superseded standard-2026-07.4 bytes are retained
  // immutably alongside it and predate the add-on entirely.
  assert.match(currentDefault, /Value: standard-2026-08\.12/u);
  assert.match(immutableBaseline, /Value: standard-2026-07\.4/u);

  const { ceiling, rest } = splitDenyCeiling(currentDefault);
  for (const action of ADD_ON_EXPORT_READS) {
    // Permitted by the ceiling, so this add-on's scoped Allow can take effect.
    assert.match(ceiling, new RegExp(`^\\s*-\\s*${action}\\s*$`, "mu"));
    // Never granted by the base role — the scoped Allows stay owned by the add-on.
    assert.doesNotMatch(rest, new RegExp(action, "u"));
    // Absent from the superseded baseline in either form.
    assert.doesNotMatch(immutableBaseline, new RegExp(action, "u"));
    assert.ok(runbook.includes(`\`${action}\``));
  }
  assert.match(runbook, /Do not launch the add-on against the superseded `standard-2026-07\.4`/u);
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
