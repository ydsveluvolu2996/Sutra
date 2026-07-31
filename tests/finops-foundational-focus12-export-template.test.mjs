import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseCurCsv } from "../lib/finops-cur.ts";

const template = await readFile(
  new URL(
    "../infrastructure/finops-foundational-focus12-export-v1.yaml",
    import.meta.url,
  ),
  "utf8",
);
const runbook = await readFile(
  new URL(
    "../docs/finops-foundational-focus12-export.md",
    import.meta.url,
  ),
  "utf8",
);
const successorBaseRole = await readFile(
  new URL(
    "../infrastructure/customer-onboarding-role-standard-2026-08.1.yaml",
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
const publicDefault = await readFile(
  new URL(
    "../public/sutra-customer-onboarding-role.yaml",
    import.meta.url,
  ),
  "utf8",
);

const OFFICIAL_FOCUS_12_AWS_COLUMNS = [
  "AvailabilityZone",
  "BilledCost",
  "BillingAccountId",
  "BillingAccountName",
  "BillingAccountType",
  "BillingCurrency",
  "BillingPeriodEnd",
  "BillingPeriodStart",
  "CapacityReservationId",
  "CapacityReservationStatus",
  "ChargeCategory",
  "ChargeClass",
  "ChargeDescription",
  "ChargeFrequency",
  "ChargePeriodEnd",
  "ChargePeriodStart",
  "CommitmentDiscountCategory",
  "CommitmentDiscountId",
  "CommitmentDiscountName",
  "CommitmentDiscountQuantity",
  "CommitmentDiscountStatus",
  "CommitmentDiscountType",
  "CommitmentDiscountUnit",
  "ConsumedQuantity",
  "ConsumedUnit",
  "ContractedCost",
  "ContractedUnitPrice",
  "EffectiveCost",
  "InvoiceId",
  "InvoiceIssuerName",
  "ListCost",
  "ListUnitPrice",
  "PricingCategory",
  "PricingCurrency",
  "PricingCurrencyContractedUnitPrice",
  "PricingCurrencyEffectiveCost",
  "PricingCurrencyListUnitPrice",
  "PricingQuantity",
  "PricingUnit",
  "ProviderName",
  "PublisherName",
  "RegionId",
  "RegionName",
  "ResourceId",
  "ResourceName",
  "ResourceType",
  "ServiceCategory",
  "ServiceName",
  "ServiceSubcategory",
  "SkuId",
  "SkuMeter",
  "SkuPriceId",
  "SkuPriceDetails",
  "SubAccountId",
  "SubAccountName",
  "SubAccountType",
  "Tags",
  "x_Discounts",
  "x_Operation",
  "x_ServiceCode",
];

function resourceBlock(logicalId, nextLogicalId) {
  const start = template.indexOf(`  ${logicalId}:`);
  assert.notEqual(start, -1, `${logicalId} resource must exist`);
  const end = nextLogicalId === null
    ? template.indexOf("\nOutputs:", start)
    : template.indexOf(`\n  ${nextLogicalId}:`, start);
  assert.notEqual(end, -1, `${logicalId} resource must be bounded`);
  return template.slice(start, end);
}

function queryColumns() {
  const match = /QueryStatement:\s*>-\s*\n([\s\S]*?)\n\s*TableConfigurations:/u.exec(
    dataExport,
  );
  assert.notEqual(match, null, "the native export query must be bounded");
  const query = match[1].replace(/\s+/gu, " ").trim();
  const queryMatch = /^SELECT (.+) FROM FOCUS_1_2_AWS$/u.exec(query);
  assert.notEqual(queryMatch, null, "the query must target only FOCUS_1_2_AWS");
  return queryMatch[1].split(",").map((column) => column.trim());
}

function csvField(value) {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const bucket = resourceBlock("FocusExportBucket", "FocusExportBucketPolicy");
const bucketPolicy = resourceBlock(
  "FocusExportBucketPolicy",
  "FoundationalFocus12Export",
);
const dataExport = resourceBlock(
  "FoundationalFocus12Export",
  "CollectorFocus12ReadPolicy",
);
const collectorPolicy = resourceBlock("CollectorFocus12ReadPolicy", null);

test("the add-on is immutable, native, FOCUS 1.2-specific and source-only", () => {
  assert.match(template, /Contract: foundational-focus12-export-v1/u);
  assert.match(template, /AwsTable: FOCUS_1_2_AWS/u);
  assert.match(dataExport, /Type: AWS::BCMDataExports::Export/u);
  assert.match(
    template,
    /BaseCollectorPermissionPackVersion:[\s\S]*Default: standard-2026-08\.1[\s\S]*AllowedValues:\s*\n\s*- standard-2026-08\.1/u,
  );
  assert.doesNotMatch(template, /standard-2026-07\.4/u);
  assert.doesNotMatch(template, /Custom::|AWS::Lambda::Function|ServiceToken/u);
  assert.doesNotMatch(template, /Type: AWS::IAM::Role/u);
  assert.match(runbook, /does not publish the template/u);
  assert.match(runbook, /does not publish[\s\S]*update the default or[\s\S]*public onboarding template/u);
  assert.match(currentDefault, /Value: standard-2026-07\.4/u);
  assert.match(publicDefault, /Value: standard-2026-07\.4/u);
});

test("the created or explicitly attested destination is dedicated, private and retained", () => {
  assert.match(
    template,
    /ExistingBucketName:[\s\S]*Default: ''[\s\S]*AllowedPattern:/u,
  );
  assert.match(
    template,
    /ExistingBucketContract:[\s\S]*Default: not-applicable[\s\S]*- dedicated-private-retained/u,
  );
  assert.match(
    template,
    /ExistingBucketMeetsDestinationContract:[\s\S]*Ref: ExistingBucketName[\s\S]*Ref: ExistingBucketContract[\s\S]*dedicated-private-retained/u,
  );
  assert.match(bucket, /Type: AWS::S3::Bucket/u);
  assert.match(bucket, /DeletionPolicy: Retain/u);
  assert.match(bucket, /UpdateReplacePolicy: Retain/u);
  assert.match(bucket, /SSEAlgorithm: AES256/u);
  assert.match(bucket, /ObjectOwnership: BucketOwnerEnforced/u);
  assert.match(bucket, /VersioningConfiguration:\s*\n\s*Status: Enabled/u);
  for (const setting of [
    "BlockPublicAcls",
    "BlockPublicPolicy",
    "IgnorePublicAcls",
    "RestrictPublicBuckets",
  ]) {
    assert.match(bucket, new RegExp(`${setting}: true`, "u"));
  }
});

test("the Data Exports service can write only the exact account/name-bound namespace", () => {
  assert.match(bucketPolicy, /Service: bcm-data-exports\.amazonaws\.com/u);
  assert.match(bucketPolicy, /Action: s3:PutObject/u);
  assert.match(
    bucketPolicy,
    /arn:\$\{AWS::Partition\}:s3:::\$\{DestinationBucket\}\/\$\{ExportPrefix\}\/\$\{ExportName\}\/\*/u,
  );
  assert.match(
    bucketPolicy,
    /arn:\$\{AWS::Partition\}:bcm-data-exports:\$\{AWS::Region\}:\$\{AWS::AccountId\}:export\/\$\{ExportName\}-\*/u,
  );
  assert.match(
    bucketPolicy,
    /aws:SourceAccount:\s*\n\s*Ref: AWS::AccountId/u,
  );
  assert.doesNotMatch(bucketPolicy, /Principal:\s*['"]?\*['"]?/u);
  assert.doesNotMatch(bucketPolicy, /s3:GetObject|s3:DeleteObject/u);
});

test("the native query selects exactly the complete current FOCUS 1.2 AWS schema", () => {
  assert.deepEqual(queryColumns(), OFFICIAL_FOCUS_12_AWS_COLUMNS);
  assert.equal(
    new Set(queryColumns()).size,
    OFFICIAL_FOCUS_12_AWS_COLUMNS.length,
    "the FOCUS query must not contain duplicate columns",
  );
  assert.doesNotMatch(dataExport, /FROM FOCUS_1_0_AWS/u);
  assert.doesNotMatch(
    dataExport,
    /\b(?:InvoiceIssuerId|CommitmentDiscountStartDate|CommitmentDiscountExpirationDate|x_CostCategories)\b/u,
  );
  assert.match(
    dataExport,
    /TableConfigurations:\s*\n\s*FOCUS_1_2_AWS:\s*\n\s*TIME_GRANULARITY: HOURLY/u,
  );
  assert.doesNotMatch(
    dataExport,
    /TIME_GRANULARITY: (?:DAILY|MONTHLY)|COST_AND_USAGE_REPORT:/u,
  );
  assert.doesNotMatch(dataExport, /\bWHERE\b|\bLIMIT\b|\b AS \b/u);
  assert.match(dataExport, /Compression: GZIP/u);
  assert.match(dataExport, /Format: TEXT_OR_CSV/u);
  assert.match(dataExport, /OutputType: CUSTOM/u);
  assert.equal(
    [...dataExport.matchAll(/^\s*OutputType:\s+CUSTOM\s*$/gmu)].length,
    1,
    "the output type must be declared exactly once in the raw YAML contract",
  );
  assert.match(dataExport, /Overwrite: CREATE_NEW_REPORT/u);
  assert.match(dataExport, /Frequency: SYNCHRONOUS/u);
});

test("the exact native export header is accepted as FOCUS 1.2 by the canonical parser", () => {
  const values = Object.fromEntries(
    OFFICIAL_FOCUS_12_AWS_COLUMNS.map((column) => [column, ""]),
  );
  Object.assign(values, {
    BilledCost: "1.25",
    BillingAccountId: "111111111111",
    BillingAccountName: "Example management",
    BillingAccountType: "AWS Organization",
    BillingCurrency: "USD",
    BillingPeriodEnd: "2026-08-01T00:00:00Z",
    BillingPeriodStart: "2026-07-01T00:00:00Z",
    ChargeCategory: "Usage",
    ChargeDescription: "EC2 compute",
    ChargeFrequency: "Usage-Based",
    ChargePeriodEnd: "2026-07-01T01:00:00Z",
    ChargePeriodStart: "2026-07-01T00:00:00Z",
    EffectiveCost: "1.10",
    ProviderName: "AWS",
    PublisherName: "Amazon Web Services, Inc.",
    ServiceCategory: "Compute",
    ServiceName: "Amazon EC2",
    ServiceSubcategory: "Virtual Machines",
    SkuMeter: "USE1-BoxUsage:m7g.large",
    SubAccountId: "222222222222",
    SubAccountName: "Example workload",
    SubAccountType: "Linked Account",
    Tags: JSON.stringify({ env: "prod" }),
  });
  const csv = [
    OFFICIAL_FOCUS_12_AWS_COLUMNS.map(csvField).join(","),
    OFFICIAL_FOCUS_12_AWS_COLUMNS.map((column) => csvField(values[column])).join(","),
  ].join("\n");
  const parsed = parseCurCsv(csv);
  if ("error" in parsed) throw new Error(parsed.error);
  assert.equal(parsed.dialect, "focus-1.2");
  assert.equal(parsed.sourceFormat, "focus");
  assert.equal(parsed.sourceVersion, "1.2");
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.rejected.length, 0);
  assert.equal(parsed.lines[0].amountMicros, "1250000");
  assert.equal(parsed.lines[0].usageAccountId, "222222222222");
  assert.equal(parsed.lines[0].usageType, "USE1-BoxUsage:m7g.large");
});

test("the permanent collector has only exact-prefix reads and one exact status API", () => {
  const actions = [...collectorPolicy.matchAll(
    /^\s+(?:Action:\s*|-\s+)((?:s3|bcm-data-exports):[A-Za-z0-9*]+)\s*$/gmu,
  )].map((match) => match[1]);
  assert.deepEqual(new Set(actions), new Set([
    "s3:ListBucket",
    "s3:GetBucketLocation",
    "s3:GetObject",
    "s3:GetObjectAttributes",
    "bcm-data-exports:GetExport",
  ]));
  assert.equal(actions.length, 5, "collector actions must not be duplicated");
  assert.match(
    collectorPolicy,
    /s3:prefix:[\s\S]*\$\{ExportPrefix\}\/\$\{ExportName\}[\s\S]*\$\{ExportPrefix\}\/\$\{ExportName\}\/\*/u,
  );
  assert.match(
    collectorPolicy,
    /ReadOnlyExactFocus12ExportObjects[\s\S]*arn:\$\{AWS::Partition\}:s3:::\$\{DestinationBucket\}\/\$\{ExportPrefix\}\/\$\{ExportName\}\/\*/u,
  );
  assert.match(
    collectorPolicy,
    /ReadOnlyThisFocus12ExportStatus[\s\S]*Fn::GetAtt:[\s\S]*FoundationalFocus12Export[\s\S]*ExportArn/u,
  );
  assert.doesNotMatch(
    collectorPolicy,
    /ListExports|ListExecutions|GetExecution|ListTables|GetTable|CreateExport|UpdateExport|DeleteExport|TagResource|UntagResource|PutObject|DeleteObject|Action:\s*['"]?\*['"]?/u,
  );
});

test("standard-2026-08.1 ceiling-permits exactly what this add-on needs without granting it", () => {
  const collectorActions = new Set([
    "s3:ListBucket",
    "s3:GetBucketLocation",
    "s3:GetObject",
    "s3:GetObjectAttributes",
    "bcm-data-exports:GetExport",
  ]);
  for (const action of collectorActions) {
    assert.match(successorBaseRole, new RegExp(`^\\s+- ${action}$`, "mu"));
    assert.equal(
      [...successorBaseRole.matchAll(new RegExp(`^\\s+- ${action}$`, "gmu"))].length,
      1,
      `${action} must occur only once in the base role deny ceiling`,
    );
  }
  assert.doesNotMatch(
    successorBaseRole,
    /bcm-data-exports:(?:Create|Update|Delete)Export|s3:(?:Put|Delete)Object/u,
  );
});

test("the runbook pins authoritative evidence and keeps publication and activation gated", () => {
  for (const fragment of [
    "dataexports-quotas.html",
    "table-dictionary-focus-1-2-aws.html",
    "table-dictionary-focus-1-2-aws-columns.html",
    "dataexports-create-standard.html",
    "aws-resource-bcmdataexports-export.html",
    "dataexports-data-query.html",
    "dataexports-export-delivery.html",
    "dataexports-s3-bucket.html",
    "API_DataExports_GetExport.html",
  ]) {
    assert.ok(runbook.includes(fragment), `${fragment} official reference must be pinned`);
  }
  assert.match(runbook, /must never replace[\s\S]*`FOCUS_1_0_AWS`/u);
  assert.match(runbook, /initial delivery can take up to\s+24 hours/u);
  assert.match(runbook, /configuration-required or waiting/u);
  assert.match(runbook, /must not fall back to FOCUS 1\.0, fixture data/u);
  assert.match(runbook, /tenant-isolation[\s\S]*production acceptance gates/u);
});
