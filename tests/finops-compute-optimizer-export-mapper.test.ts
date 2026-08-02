import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG,
  COMPUTE_OPTIMIZER_EXPORT_MATERIALIZATION_PROJECTION,
} from
  "../lib/finops-compute-optimizer-export-field-catalog.ts";
import {
  COMPUTE_OPTIMIZER_EXPORT_MAPPER_DISCLOSURE,
  ComputeOptimizerExportMapperError,
  mapComputeOptimizerExportTarget,
} from "../lib/finops-compute-optimizer-export-mapper.ts";
import type {
  LoadedComputeOptimizerExportTargetBundle,
} from "../lib/finops-compute-optimizer-export-object-set.ts";
import {
  parseComputeOptimizerExport,
  type ComputeOptimizerCsvwColumn,
} from "../lib/finops-compute-optimizer-export-parser.ts";
import type {
  ComputeOptimizerExportFamily,
  ComputeOptimizerExportPlan,
  ComputeOptimizerProviderExportJobResourceType,
} from "../lib/finops-compute-optimizer-export-plan.ts";
import { createComputeOptimizerExportPlan } from
  "../lib/finops-compute-optimizer-export-plan.ts";

const ACCOUNT = "111122223333";
const REGION = "us-east-1";
const encoder = new TextEncoder();

const FAMILIES = [
  "EC2_INSTANCE",
  "AUTO_SCALING_GROUP",
  "EBS_VOLUME",
  "LAMBDA_FUNCTION",
  "ECS_SERVICE",
  "LICENSE",
  "RDS_DATABASE",
  "IDLE_RESOURCE",
] as const satisfies readonly ComputeOptimizerExportFamily[];

const PROVIDER: Readonly<Record<
  ComputeOptimizerExportFamily,
  ComputeOptimizerProviderExportJobResourceType
>> = {
  EC2_INSTANCE: "Ec2Instance",
  AUTO_SCALING_GROUP: "AutoScalingGroup",
  EBS_VOLUME: "EbsVolume",
  LAMBDA_FUNCTION: "LambdaFunction",
  ECS_SERVICE: "EcsService",
  LICENSE: "License",
  RDS_DATABASE: "AuroraDBClusterStorage",
  IDLE_RESOURCE: "Idle",
};

const ARNS: Readonly<Record<ComputeOptimizerExportFamily, string>> = {
  EC2_INSTANCE: `arn:aws:ec2:${REGION}:${ACCOUNT}:instance/i-0123456789abcdef0`,
  AUTO_SCALING_GROUP:
    `arn:aws:autoscaling:${REGION}:${ACCOUNT}:autoScalingGroup:uuid:autoScalingGroupName/team-asg`,
  EBS_VOLUME: `arn:aws:ec2:${REGION}:${ACCOUNT}:volume/vol-0123456789abcdef0`,
  LAMBDA_FUNCTION: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:processor`,
  ECS_SERVICE: `arn:aws:ecs:${REGION}:${ACCOUNT}:service/cluster/service-a`,
  LICENSE: `arn:aws:license-manager:${REGION}:${ACCOUNT}:license-configuration/lic-1`,
  RDS_DATABASE: `arn:aws:rds:${REGION}:${ACCOUNT}:cluster:aurora-cluster-1`,
  IDLE_RESOURCE: `arn:aws:ec2:${REGION}:${ACCOUNT}:instance/i-idle0001`,
};

const GUIDE_COLUMN: Readonly<
  Partial<Record<ComputeOptimizerExportFamily, Readonly<Record<string, string>>>>
> = {
  EC2_INSTANCE: {
    AccountId: "accountId",
    CurrentInstanceType: "currentInstanceType",
    Finding: "finding",
    InstanceArn: "instanceArn",
    LastRefreshTimestamp: "lastRefreshTimestamp_UTC",
    LookbackPeriodInDays: "lookBackPeriodInDays",
  },
  AUTO_SCALING_GROUP: {
    AccountId: "accountId",
    AutoScalingGroupArn: "autoScalingGroupArn",
    AutoScalingGroupName: "autoScalingGroupName",
    CurrentConfigurationDesiredCapacity: "currentConfiguration_desiredCapacity",
    CurrentConfigurationInstanceType: "currentConfiguration_instanceType",
    Finding: "finding",
    LastRefreshTimestamp: "lastRefreshTimestamp",
    LookbackPeriodInDays: "lookBackPeriodInDays",
  },
  EBS_VOLUME: {
    AccountId: "accountId",
    Finding: "finding",
    LastRefreshTimestamp: "lastRefreshTimestamp",
    LookbackPeriodInDays: "lookBackPeriodInDays",
  },
  LAMBDA_FUNCTION: {
    AccountId: "accountId",
    Finding: "finding",
    LastRefreshTimestamp: "lastRefreshTimestamp",
    LookbackPeriodInDays: "lookBackPeriodInDays",
  },
  ECS_SERVICE: {
    AccountId: "accountId",
    CurrentServiceConfigurationCpu: "currentServiceConfiguration_cpu",
    CurrentServiceConfigurationMemory: "currentServiceConfiguration_memory",
    CurrentServiceConfigurationTaskDefinitionArn: "currentServiceConfiguration_taskDefinitionArn",
    Finding: "findings",
    LastRefreshTimestamp: "lastRefreshTimestamp_UTC",
    LaunchType: "launchType",
    LookbackPeriodInDays: "lookBackPeriodInDays",
    ServiceArn: "serviceArn",
  },
};

function rankedColumn(
  family: ComputeOptimizerExportFamily,
  field: string,
  rank: number,
): string | null {
  const map: Partial<Record<ComputeOptimizerExportFamily, Record<string, string>>> = {
    EC2_INSTANCE: {
      RecommendationOptionsInstanceType: `recommendationOptions_${rank}_instanceType`,
      RecommendationOptionsPerformanceRisk: `recommendationOptions_${rank}_performanceRisk`,
    },
    AUTO_SCALING_GROUP: {
      RecommendationOptionsConfigurationDesiredCapacity:
        `recommendationOptions_${rank}_configuration_desiredCapacity`,
      RecommendationOptionsConfigurationInstanceType:
        `recommendationOptions_${rank}_configuration_instanceType`,
      RecommendationOptionsPerformanceRisk: `recommendationOptions_${rank}_performanceRisk`,
    },
    EBS_VOLUME: {
      RecommendationOptionsConfigurationVolumeBaselineIOPS:
        `RecommendationOptions_${rank}_ConfigurationVolumeBaselineIOPS`,
      RecommendationOptionsConfigurationVolumeBaselineThroughput:
        `RecommendationOptions_${rank}_ConfigurationVolumeBaselineThroughput`,
      RecommendationOptionsConfigurationVolumeSize:
        `RecommendationOptions_${rank}_ConfigurationVolumeSize`,
      RecommendationOptionsConfigurationVolumeType:
        `RecommendationOptions_${rank}_ConfigurationVolumeType`,
      RecommendationOptionsPerformanceRisk: `recommendationOptions_${rank}_performanceRisk`,
    },
    LAMBDA_FUNCTION: {
      RecommendationOptionsConfigurationMemorySize:
        `RecommendationOptions_${rank}_ConfigurationMemorySize`,
    },
    ECS_SERVICE: {
      RecommendationOptionsCpu: `recommendationOptions_${rank}_cpu`,
      RecommendationOptionsMemory: `recommendationOptions_${rank}_memory`,
    },
  };
  return map[family]?.[field] ?? null;
}

function projection(family: ComputeOptimizerExportFamily): readonly string[] {
  return COMPUTE_OPTIMIZER_EXPORT_MATERIALIZATION_PROJECTION[family];
}

const INTEGER_FIELDS = new Set([
  "CurrentConfigurationDesiredCapacity",
  "RecommendationOptionsConfigurationDesiredCapacity",
  "CurrentConfigurationVolumeBaselineIOPS",
  "CurrentConfigurationVolumeBaselineThroughput",
  "CurrentConfigurationVolumeSize",
  "RecommendationOptionsConfigurationVolumeBaselineIOPS",
  "RecommendationOptionsConfigurationVolumeBaselineThroughput",
  "RecommendationOptionsConfigurationVolumeSize",
  "CurrentConfigurationMemorySize",
  "CurrentConfigurationTimeout",
  "RecommendationOptionsConfigurationMemorySize",
  "CurrentServiceConfigurationCpu",
  "CurrentServiceConfigurationMemory",
  "RecommendationOptionsCpu",
  "RecommendationOptionsMemory",
  "CurrentLicenseConfigurationNumberOfCores",
  "CurrentStorageConfigurationAllocatedStorage",
  "CurrentStorageConfigurationIOPS",
  "CurrentStorageConfigurationMaxAllocatedStorage",
  "CurrentStorageConfigurationStorageThroughput",
  "StorageRecommendationOptionsAllocatedStorage",
  "StorageRecommendationOptionsIOPS",
  "StorageRecommendationOptionsMaxAllocatedStorage",
  "StorageRecommendationOptionsStorageThroughput",
  "InstanceRecommendationOptionsRank",
  "StorageRecommendationOptionsRank",
  "PromotionTier",
]);

function datatype(field: string): ComputeOptimizerCsvwColumn["datatype"] {
  if (field === "LastRefreshTimestamp") return "datetime";
  if (
    field === "LookbackPeriodInDays"
    || field.includes("EstimatedMonthlySavingsValue")
    || /SavingsOpportunity.*Percentage$/u.test(field)
    || field.includes("PerformanceRisk") && !field.startsWith("Current")
  ) return "double";
  if (INTEGER_FIELDS.has(field)) return "integer";
  return "string";
}

function apiValue(family: ComputeOptimizerExportFamily, field: string, rank: number | null): string {
  if (field === "AccountId") return ACCOUNT;
  if (["InstanceArn", "AutoScalingGroupArn", "VolumeArn", "FunctionArn", "ServiceArn", "ResourceArn"]
    .includes(field)) return ARNS[family];
  if (field === "AutoScalingGroupName") return "team-asg";
  if (field === "ResourceId") return "i-idle0001";
  if (field === "ResourceType") return "Ec2Instance";
  if (field === "FunctionVersion") return "$LATEST";
  if (field === "DBClusterIdentifier") return "aurora-cluster-1";
  if (field === "Engine") return "aurora-postgresql";
  if (field === "EngineVersion") return "16.1";
  if (field === "ClusterWriter") return "true";
  if (field === "MultiAZDBInstance") return "false";
  if (field === "LastRefreshTimestamp") return "2026-08-02 00:00:00";
  if (field === "LookbackPeriodInDays") return "14.0";
  if (field.endsWith("Finding") || field === "Finding") return "Optimized";
  if (field.endsWith("FindingReasonCodes")) return "CpuOverprovisioned";
  if (field === "FindingDescription") return "Resource has low utilization";
  if (field.includes("EstimatedMonthlySavingsCurrency")) return "USD";
  if (field.includes("EstimatedMonthlySavingsValue")) {
    return field.includes("AfterDiscounts") ? "10.250000" : "12.345678";
  }
  if (field.includes("SavingsOpportunity") && field.includes("Percentage")) {
    return field.includes("AfterDiscounts") ? "10.25" : "12.34";
  }
  if (field === "SavingsOpportunity") return "provider-object-before-discounts";
  if (field === "SavingsOpportunityAfterDiscount") return "provider-object-after-discounts";
  if (field.endsWith("Rank")) return "1";
  if (field.includes("PerformanceRisk")) return field.startsWith("Current") ? "Low" : "1.250";
  if (INTEGER_FIELDS.has(field)) return rank === null ? "2" : String(rank + 1);
  if (field.includes("InstanceType") || field.includes("DBInstanceClass")) {
    return rank === null ? "m6i.large" : `m7i.${rank === 1 ? "large" : "xlarge"}`;
  }
  if (field.includes("StorageType") || field.includes("VolumeType")) return "gp3";
  if (field.includes("License")) return "Enterprise";
  if (field.includes("OperatingSystem")) return "Windows";
  if (field === "LaunchType") return "FARGATE";
  if (field === "CurrentServiceConfigurationTaskDefinitionArn") {
    return `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/service-a:1`;
  }
  return `value-${field}`;
}

interface FixtureOptions {
  readonly rows?: number;
  readonly optionCount?: number;
  readonly error?: boolean;
  readonly providerResourceType?: ComputeOptimizerProviderExportJobResourceType;
  readonly projectedFields?: readonly string[];
}

interface Fixture {
  readonly bundle: LoadedComputeOptimizerExportTargetBundle;
  readonly plan: ComputeOptimizerExportPlan;
}

async function fixture(
  family: ComputeOptimizerExportFamily,
  options: FixtureOptions = {},
): Promise<Fixture> {
  const optionCount = options.optionCount ?? (
    ["EC2_INSTANCE", "AUTO_SCALING_GROUP", "EBS_VOLUME", "LAMBDA_FUNCTION", "ECS_SERVICE"]
      .includes(family) ? 2 : 1
  );
  const providerResourceType = options.providerResourceType ?? PROVIDER[family];
  const requestedProjection = options.projectedFields ?? projection(family);
  const descriptors: Array<{
    field: string;
    name: string;
    datatype: ComputeOptimizerCsvwColumn["datatype"];
    rank: number | null;
  }> = [];
  for (const field of requestedProjection) {
    if (field === "Tags") continue;
    const firstRanked = rankedColumn(family, field, 1);
    if (firstRanked !== null) {
      for (let rank = 1; rank <= optionCount; rank += 1) {
        descriptors.push({ field, name: rankedColumn(family, field, rank)!, datatype: datatype(field), rank });
      }
    } else if (
      (family === "EC2_INSTANCE" || family === "ECS_SERVICE")
      && field === "FindingReasonCodes"
    ) {
      descriptors.push({ field, name: "findingReasonCodes_CPU", datatype: "string", rank: null });
    } else {
      descriptors.push({
        field,
        name: GUIDE_COLUMN[family]?.[field] ?? field,
        datatype: datatype(field),
        rank: null,
      });
    }
  }
  if (COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG[family].capabilityProjection.tags.supported) {
    descriptors.push({ field: "Tags", name: "tags_environment", datatype: "string", rank: null });
  }
  const columns = [
    { name: "recommendations_count", titles: "Count", datatype: "integer", required: true },
    ...descriptors.map((item) => ({
      name: item.name,
      titles: item.name.startsWith("tags_") ? `Tag: ${item.name.slice(5)}` : item.field,
      datatype: item.datatype,
      null: "",
      required: false,
      ...(item.datatype === "datetime" ? { format: "yyyy-MM-dd HH:mm:ss" } : {}),
    })),
    { name: "errorCode", titles: "Error code", datatype: "string", required: true },
    { name: "errorMessage", titles: "Error message", datatype: "string", required: true },
  ];
  const row = options.error
    ? ["0", ...descriptors.map(() => ""), "AccessDenied", "Provider could not inspect resource"]
    : [
      String(optionCount),
      ...descriptors.map((item) => item.field === "Tags"
        ? "production"
        : apiValue(family, item.field, item.rank)),
      "",
      "",
    ];
  const jobId = `job-${family.toLowerCase().replaceAll("_", "-")}`;
  const csvBasename = `${REGION}-2026-08-02T000000Z-${jobId}.csv`;
  const metadata = {
    "@context": ["http://www.w3.org/ns/csvw"],
    url: csvBasename,
    "dc:title": `${family} Recommendations`,
    "dc:modified": { "@value": "2026-08-02", "@type": "xsd:date" },
    dialect: {
      encoding: "utf-8",
      lineTerminators: ["\n"],
      doubleQuote: true,
      skipRows: 0,
      header: true,
      headerRowCount: 1,
      delimiter: ",",
      skipColumns: 0,
      skipBlankRows: false,
      trim: false,
    },
    tableSchema: { columns },
  };
  const escape = (value: string): string => /[",\r\n]/u.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
  const csv = [
    columns.map((column) => column.name).join(","),
    ...Array.from({ length: options.rows ?? 1 }, () => row.map(escape).join(",")),
  ].join("\n");
  const metadataBytes = encoder.encode(JSON.stringify(metadata));
  const csvBytes = encoder.encode(csv);
  const parsed = await parseComputeOptimizerExport({
    metadataBytes,
    csvBytes,
    trustedCsvBasename: csvBasename,
  });
  const prefix = `compute-optimizer/${ACCOUNT}/`;
  const objectKey = `${prefix}${csvBasename}`;
  const plan = await createComputeOptimizerExportPlan({
    scope: {
      orgId: "org_mapper",
      customerId: "customer_mapper",
      connectionId: `conn_${"b".repeat(32)}`,
    },
    requesterAccountId: ACCOUNT,
    partition: "aws",
    regions: [REGION],
    exportFamilies: [family],
    targets: [{
      region: REGION,
      exportFamily: family,
      bucket: "sutra-compute-optimizer-us-east-1",
      optionalPrefix: null,
      effectivePrefix: prefix,
      request: {
        operation: COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG[family].operation,
        region: REGION,
        fileFormat: "Csv",
        includeMemberAccounts: true,
        filters: [],
        fieldsToExport: requestedProjection,
        s3DestinationConfig: {
          bucket: "sutra-compute-optimizer-us-east-1",
          keyPrefix: null,
        },
      },
      expectedJob: {
        jobId,
        providerResourceType,
        bucket: "sutra-compute-optimizer-us-east-1",
        objectKey,
        metadataKey: `${objectKey.slice(0, -4)}-metadata.json`,
      },
    }],
  });
  const bundle: LoadedComputeOptimizerExportTargetBundle = {
    region: REGION,
    exportFamily: family,
    providerResourceType,
    requestSha256: plan.targets[0]!.requestSha256,
    jobId,
    bucket: "sutra-compute-optimizer-us-east-1",
    csvObject: {
      key: objectKey,
      eTag: `etag-${family}`,
      versionId: `version-${family}`,
      bytes: csvBytes.byteLength,
      sha256: parsed.objectSha256,
    },
    metadataObject: {
      key: `${objectKey.slice(0, -4)}-metadata.json`,
      eTag: `metadata-etag-${family}`,
      versionId: `metadata-version-${family}`,
      bytes: metadataBytes.byteLength,
      sha256: parsed.metadataSha256,
    },
    parsed,
  };
  return { bundle, plan };
}

function mutable<T>(value: T): T {
  return structuredClone(value);
}

function nullApiFields(source: Fixture, apiFields: readonly string[]): void {
  const columns = source.bundle.parsed.columns.filter((column) =>
    apiFields.includes(column.titles));
  assert.ok(columns.length >= apiFields.length);
  for (const row of source.bundle.parsed.rows) {
    for (const column of columns) {
      const cell = row.cells.find((candidate) => candidate.column === column.name)!;
      Object.assign(cell, {
        raw: "",
        isNull: true,
        integerLexeme: null,
        decimalLexeme: null,
      });
    }
  }
}

function hasError(code: ComputeOptimizerExportMapperError["code"]) {
  return (error: unknown) =>
    error instanceof ComputeOptimizerExportMapperError && error.code === code;
}

for (const family of FAMILIES) {
  test(`${family} maps an official-shaped CSVW row with exact lineage`, async () => {
    const { bundle, plan } = await fixture(family);
    const mapped = await mapComputeOptimizerExportTarget(bundle, plan);
    assert.equal(mapped.source.exportFamily, family);
    assert.equal(mapped.source.csvSha256, bundle.csvObject.sha256);
    assert.equal(mapped.rowCount, 1);
    assert.equal(mapped.recommendationCount, 1);
    assert.equal(mapped.rejectedRowCount, 0);
    assert.equal(mapped.recommendations[0]?.accountId, ACCOUNT);
    assert.equal(mapped.recommendations[0]?.resourceArn, ARNS[family]);
    assert.equal(mapped.recommendations[0]?.lookbackPeriodLexeme, "14.0");
    assert.equal(mapped.recommendations[0]?.lastRefreshTimestamp, "2026-08-02 00:00:00");
    assert.equal(Object.isFrozen(mapped), true);
    assert.equal(Object.isFrozen(mapped.recommendations), true);
    assert.equal(Object.isFrozen(mapped.recommendations[0]?.tags), true);
    if (["LICENSE", "RDS_DATABASE", "IDLE_RESOURCE"].includes(family)) {
      assert.equal(mapped.schemaAssurance, "API_FIELD_NAME_ONLY_UNVERIFIED");
    }
    if (mapped.recommendations[0]!.tags.length > 0) {
      assert.equal(mapped.recommendations[0]!.tags[0]!.assurance, "CSVW_NAME_AND_TITLE");
    }

    if (family === "IDLE_RESOURCE") {
      assert.deepEqual(
        mapped.recommendations[0]?.savings.map((channel) => [
          channel.includesExistingDiscounts,
          channel.normalizationState,
        ]),
        [
          [false, "UNRESOLVED_PROVIDER_CSV_LABEL"],
          [true, "UNRESOLVED_PROVIDER_CSV_LABEL"],
        ],
      );
    } else {
      const before = mapped.recommendations[0]?.savings.find((channel) =>
        !channel.includesExistingDiscounts && channel.scope !== "STORAGE");
      assert.ok(before);
      assert.match(before?.normalizationState ?? "", /^EXACT_/u);
      if (before.normalizationState !== "UNRESOLVED_PROVIDER_CSV_LABEL") {
        assert.equal(before.amountMicros, "12345678");
        assert.equal(before.percentageBasisPoints, 1234);
      }
    }
  });

  test(`${family} blocks projections missing temporal evidence or widening materialization`, async () => {
    const missingLookback = await fixture(family, {
      projectedFields: projection(family).filter((field) => field !== "LookbackPeriodInDays"),
    });
    await assert.rejects(
      mapComputeOptimizerExportTarget(missingLookback.bundle, missingLookback.plan),
      hasError("PROJECTION_MISMATCH"),
    );

    const canonical = projection(family);
    const extra = COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG[family].fieldsToExport
      .find((field) => !canonical.includes(field));
    assert.ok(extra, `${family} must retain an official field outside the materialization contract`);
    const widened = await fixture(family, {
      projectedFields: [...canonical, extra].sort(),
    });
    await assert.rejects(
      mapComputeOptimizerExportTarget(widened.bundle, widened.plan),
      hasError("PROJECTION_MISMATCH"),
    );
  });
}

test("keeps before/after discounts and RDS instance/storage evidence separate", async () => {
  const ec2Fixture = await fixture("EC2_INSTANCE");
  const ec2 = await mapComputeOptimizerExportTarget(ec2Fixture.bundle, ec2Fixture.plan);
  assert.deepEqual(
    ec2.recommendations[0]?.savings.map((channel) => [
      channel.scope,
      channel.includesExistingDiscounts,
      channel.normalizationState !== "UNRESOLVED_PROVIDER_CSV_LABEL"
        ? channel.amountMicros
        : null,
    ]),
    [
      ["RESOURCE", false, "12345678"],
      ["RESOURCE", true, "10250000"],
    ],
  );

  const rdsFixture = await fixture("RDS_DATABASE");
  const rds = await mapComputeOptimizerExportTarget(rdsFixture.bundle, rdsFixture.plan);
  assert.deepEqual(rds.recommendations[0]?.findings.map((finding) => finding.scope), [
    "INSTANCE",
    "STORAGE",
  ]);
  assert.deepEqual(rds.recommendations[0]?.savings.map((channel) => [
    channel.scope,
    channel.includesExistingDiscounts,
  ]), [
    ["INSTANCE", false],
    ["INSTANCE", true],
    ["STORAGE", false],
    ["STORAGE", true],
  ]);
  assert.equal(rds.recommendations[0]?.rds?.instance.finding?.scope, "INSTANCE");
  assert.equal(rds.recommendations[0]?.rds?.storage.finding?.scope, "STORAGE");
  assert.equal(
    rds.recommendations[0]?.rds?.auroraStorageIdentity?.providerResourceType,
    "AuroraDBClusterStorage",
  );
  assert.equal(
    rds.recommendations[0]?.rds?.auroraStorageIdentity?.dbClusterIdentifier.raw,
    "aurora-cluster-1",
  );
});

test("maps exactly the verified plan projection without requiring unrequested discount fields", async () => {
  const fields = [...new Set([
    ...COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.EC2_INSTANCE.minimumProjection,
    "LookbackPeriodInDays",
  ])].sort();
  const source = await fixture("EC2_INSTANCE", { projectedFields: fields });
  const mapped = await mapComputeOptimizerExportTarget(source.bundle, source.plan);
  assert.deepEqual(
    mapped.recommendations[0]?.savings.map((channel) => channel.includesExistingDiscounts),
    [false],
  );

  const substitutedPlan = mutable(source.plan);
  (substitutedPlan.targets[0] as { requestSha256: string }).requestSha256 = "f".repeat(64);
  await assert.rejects(
    mapComputeOptimizerExportTarget(source.bundle, substitutedPlan),
    hasError("SOURCE_LINEAGE_MISMATCH"),
  );
});

test("treats null savings channels as absent and rejects partial triples", async () => {
  const absent = mutable(await fixture("EC2_INSTANCE"));
  nullApiFields(absent, [
    "RecommendationOptionsEstimatedMonthlySavingsCurrency",
    "RecommendationOptionsEstimatedMonthlySavingsValue",
    "RecommendationOptionsSavingsOpportunityPercentage",
    "RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
    "RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
  ]);
  const mapped = await mapComputeOptimizerExportTarget(absent.bundle, absent.plan);
  assert.deepEqual(mapped.recommendations[0]?.savings, []);

  const partial = mutable(await fixture("EC2_INSTANCE"));
  nullApiFields(partial, [
    "RecommendationOptionsEstimatedMonthlySavingsCurrency",
    "RecommendationOptionsSavingsOpportunityPercentage",
  ]);
  await assert.rejects(
    mapComputeOptimizerExportTarget(partial.bundle, partial.plan),
    hasError("ROW_EVIDENCE_INVALID"),
  );
});

test("branches RDS instance and Aurora storage requirements without fabricating absent channels", async () => {
  const aurora = mutable(await fixture("RDS_DATABASE", {
    providerResourceType: "AuroraDBClusterStorage",
  }));
  nullApiFields(aurora, [
    "InstanceFinding",
    "InstanceFindingReasonCodes",
    "InstanceRecommendationOptionsEstimatedMonthlySavingsCurrency",
    "InstanceRecommendationOptionsEstimatedMonthlySavingsValue",
    "InstanceRecommendationOptionsSavingsOpportunityPercentage",
    "InstanceRecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "InstanceRecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
    "InstanceRecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
  ]);
  const mappedAurora = await mapComputeOptimizerExportTarget(aurora.bundle, aurora.plan);
  assert.equal(mappedAurora.recommendations[0]?.rds?.instance.availability, "ABSENT_IN_PROVIDER_ROW");
  assert.equal(mappedAurora.recommendations[0]?.rds?.instance.finding, null);
  assert.deepEqual(mappedAurora.recommendations[0]?.rds?.instance.savings, []);
  assert.equal(mappedAurora.recommendations[0]?.rds?.storage.availability, "PRESENT");
  assert.equal(
    mappedAurora.recommendations[0]?.rds?.auroraStorageIdentity?.dbClusterIdentifier.raw,
    "aurora-cluster-1",
  );

  const instance = mutable(await fixture("RDS_DATABASE", {
    providerResourceType: "RdsDBInstance",
  }));
  nullApiFields(instance, ["DBClusterIdentifier", "ClusterWriter", "PromotionTier"]);
  const mappedInstance = await mapComputeOptimizerExportTarget(instance.bundle, instance.plan);
  assert.equal(mappedInstance.recommendations[0]?.rds?.instance.availability, "PRESENT");
  assert.equal(mappedInstance.recommendations[0]?.rds?.auroraStorageIdentity, null);
});

test("preserves ranked option alignment and exact risk lexemes", async () => {
  const source = await fixture("EC2_INSTANCE");
  const mapped = await mapComputeOptimizerExportTarget(source.bundle, source.plan);
  assert.deepEqual(mapped.recommendations[0]?.rankedOptions.map((option) => option.rank), [1, 2]);
  assert.deepEqual(
    mapped.recommendations[0]?.rankedOptions.map((option) => option.risk?.raw),
    ["1.250", "1.250"],
  );
  assert.equal(mapped.recommendations[0]?.currentRisk[0]?.raw, "Low");
});

test("records provider error rows as rejected evidence, never recommendations", async () => {
  const source = await fixture("EC2_INSTANCE", { error: true });
  const mapped = await mapComputeOptimizerExportTarget(source.bundle, source.plan);
  assert.equal(mapped.recommendationCount, 0);
  assert.equal(mapped.rejectedRowCount, 1);
  assert.deepEqual(mapped.rejectedRows[0], {
    rowNumber: 1,
    errorCode: "AccessDenied",
    errorMessage: "Provider could not inspect resource",
    accountId: null,
    resourceArn: null,
  });
});

test("rejects missing projection fields and metadata type substitution", async () => {
  const missing = mutable(await fixture("LAMBDA_FUNCTION"));
  const columnIndex = missing.bundle.parsed.columns.findIndex((column) =>
    column.name === "lastRefreshTimestamp");
  (missing.bundle.parsed.columns as ComputeOptimizerCsvwColumn[]).splice(columnIndex, 1);
  for (const row of missing.bundle.parsed.rows) {
    (row.cells as unknown[]).splice(columnIndex, 1);
  }
  await assert.rejects(
    mapComputeOptimizerExportTarget(missing.bundle, missing.plan),
    hasError("PROJECTION_MISMATCH"),
  );

  const wrongType = mutable(await fixture("EBS_VOLUME"));
  const finding = wrongType.bundle.parsed.columns.find((column) => column.name === "finding")!;
  (finding as { datatype: string }).datatype = "integer";
  await assert.rejects(
    mapComputeOptimizerExportTarget(wrongType.bundle, wrongType.plan),
    hasError("SCHEMA_MISMATCH"),
  );
});

test("rejects monetary overflow, sub-micro precision and fractional basis points", async () => {
  for (const [column, raw] of [
    ["RecommendationOptionsEstimatedMonthlySavingsValue", "9223372036855"],
    ["RecommendationOptionsEstimatedMonthlySavingsValue", "1.0000001"],
    ["RecommendationOptionsSavingsOpportunityPercentage", "12.345"],
  ] as const) {
    const source = mutable(await fixture("EC2_INSTANCE"));
    const cell = source.bundle.parsed.rows[0]!.cells.find((entry) => entry.column === column)!;
    (cell as { raw: string; decimalLexeme: string }).raw = raw;
    (cell as { raw: string; decimalLexeme: string }).decimalLexeme = raw;
    await assert.rejects(
      mapComputeOptimizerExportTarget(source.bundle, source.plan),
      hasError("NUMERIC_EVIDENCE_INVALID"),
    );
  }
});

test("rejects tag-key and tag-value injection instead of building an object map", async () => {
  const keyInjection = mutable(await fixture("EC2_INSTANCE"));
  const tagColumn = keyInjection.bundle.parsed.columns.find((column) => column.name === "tags_environment")!;
  (tagColumn as { name: string }).name = "tags___proto__";
  const tagCell = keyInjection.bundle.parsed.rows[0]!.cells.find((cell) =>
    cell.column === "tags_environment")!;
  (tagCell as { column: string }).column = "tags___proto__";
  await assert.rejects(
    mapComputeOptimizerExportTarget(keyInjection.bundle, keyInjection.plan),
    hasError("TAG_EVIDENCE_INVALID"),
  );

  const valueInjection = mutable(await fixture("EC2_INSTANCE"));
  const value = valueInjection.bundle.parsed.rows[0]!.cells.find((cell) =>
    cell.column === "tags_environment")!;
  (value as { raw: string }).raw = "<script>alert(1)</script>";
  await assert.rejects(
    mapComputeOptimizerExportTarget(valueInjection.bundle, valueInjection.plan),
    hasError("TAG_EVIDENCE_INVALID"),
  );
});

test("rejects rank gaps and option-count mismatches", async () => {
  const source = mutable(await fixture("EC2_INSTANCE", { optionCount: 2 }));
  const rankTwo = source.bundle.parsed.rows[0]!.cells.find((cell) =>
    cell.column === "recommendationOptions_2_instanceType")!;
  Object.assign(rankTwo, { raw: "", isNull: true });
  await assert.rejects(
    mapComputeOptimizerExportTarget(source.bundle, source.plan),
    hasError("RANK_MISMATCH"),
  );
});

test("enforces duplicate resources, row caps, and no partial output", async () => {
  const duplicate = await fixture("ECS_SERVICE", { rows: 2 });
  await assert.rejects(
    mapComputeOptimizerExportTarget(duplicate.bundle, duplicate.plan),
    hasError("DUPLICATE_RESOURCE"),
  );

  const tooManyOptions = mutable(await fixture("EC2_INSTANCE"));
  const count = tooManyOptions.bundle.parsed.rows[0]!.cells.find((cell) =>
    cell.column === "recommendations_count")!;
  Object.assign(count, { raw: "11", integerLexeme: "11" });
  await assert.rejects(
    mapComputeOptimizerExportTarget(tooManyOptions.bundle, tooManyOptions.plan),
    hasError("LIMIT_EXCEEDED"),
  );

  const mixed = mutable(await fixture("EC2_INSTANCE", { rows: 2 }));
  const secondArn = mixed.bundle.parsed.rows[1]!.cells.find((cell) => cell.column === "instanceArn")!;
  (secondArn as { raw: string }).raw =
    `arn:aws:ec2:${REGION}:${ACCOUNT}:instance/i-0123456789abcdef1`;
  const bad = mixed.bundle.parsed.rows[1]!.cells.find((cell) =>
    cell.column === "RecommendationOptionsEstimatedMonthlySavingsValue")!;
  Object.assign(bad, { raw: "1.0000001", decimalLexeme: "1.0000001" });
  await assert.rejects(
    mapComputeOptimizerExportTarget(mixed.bundle, mixed.plan),
    hasError("NUMERIC_EVIDENCE_INVALID"),
  );
});

test("rejects source object/hash lineage substitution", async () => {
  const source = mutable(await fixture("LICENSE"));
  (source.bundle.csvObject as { sha256: string }).sha256 = "f".repeat(64);
  await assert.rejects(
    mapComputeOptimizerExportTarget(source.bundle, source.plan),
    hasError("SOURCE_LINEAGE_MISMATCH"),
  );
});

test("publishes unresolved CSV-label scope instead of guessing", () => {
  assert.deepEqual(COMPUTE_OPTIMIZER_EXPORT_MAPPER_DISCLOSURE.unresolvedCsvLabelFamilies, [
    "LICENSE",
    "RDS_DATABASE",
    "IDLE_RESOURCE",
  ]);
  assert.equal(Object.isFrozen(COMPUTE_OPTIMIZER_EXPORT_MAPPER_DISCLOSURE), true);
  assert.equal(
    Object.isFrozen(COMPUTE_OPTIMIZER_EXPORT_MAPPER_DISCLOSURE.unresolvedCsvLabelFamilies),
    true,
  );
});
