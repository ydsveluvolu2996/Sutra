import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPUTE_OPTIMIZER_EXPORT_FAMILIES,
  COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG,
  COMPUTE_OPTIMIZER_EXPORT_FIELD_EVIDENCE,
  COMPUTE_OPTIMIZER_EXPORT_MATERIALIZATION_PROJECTION,
  ComputeOptimizerExportFieldCatalogError,
  validateComputeOptimizerFieldsToExport,
} from "../lib/finops-compute-optimizer-export-field-catalog.ts";

const EXPECTED_FIELD_COUNT = Object.freeze({
  EC2_INSTANCE: 71,
  AUTO_SCALING_GROUP: 73,
  EBS_VOLUME: 38,
  LAMBDA_FUNCTION: 31,
  ECS_SERVICE: 29,
  LICENSE: 21,
  RDS_DATABASE: 82,
  IDLE_RESOURCE: 39,
} as const);

const EXPECTED_MATERIALIZATION_ONLY_FIELDS = Object.freeze({
  EC2_INSTANCE: [
    "LookbackPeriodInDays",
    "RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
    "RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
  ],
  AUTO_SCALING_GROUP: [
    "LookbackPeriodInDays",
    "RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
    "RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
  ],
  EBS_VOLUME: [
    "LookbackPeriodInDays",
    "RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
    "RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
  ],
  LAMBDA_FUNCTION: [
    "LookbackPeriodInDays",
    "RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
    "RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
  ],
  ECS_SERVICE: [
    "LookbackPeriodInDays",
    "RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
    "RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
  ],
  LICENSE: ["LookbackPeriodInDays"],
  RDS_DATABASE: [
    "InstanceRecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "InstanceRecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
    "InstanceRecommendationOptionsRank",
    "InstanceRecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
    "LookbackPeriodInDays",
    "StorageRecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "StorageRecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
    "StorageRecommendationOptionsRank",
    "StorageRecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
  ],
  IDLE_RESOURCE: ["LookbackPeriodInDays"],
} as const);

function hasError(code: ComputeOptimizerExportFieldCatalogError["code"]) {
  return (error: unknown) =>
    error instanceof ComputeOptimizerExportFieldCatalogError && error.code === code;
}

for (const family of COMPUTE_OPTIMIZER_EXPORT_FAMILIES) {
  test(`${family} exposes a complete immutable allowlist and valid minimum`, () => {
    const catalogEntry = COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG[family];
    assert.equal(catalogEntry.fieldsToExport.length, EXPECTED_FIELD_COUNT[family]);
    assert.deepEqual(catalogEntry.fieldsToExport, [...catalogEntry.fieldsToExport].sort());
    assert.equal(new Set(catalogEntry.fieldsToExport).size, catalogEntry.fieldsToExport.length);
    assert.equal(Object.isFrozen(catalogEntry), true);
    assert.equal(Object.isFrozen(catalogEntry.fieldsToExport), true);
    assert.equal(Object.isFrozen(catalogEntry.minimumProjection), true);
    const materializationProjection =
      COMPUTE_OPTIMIZER_EXPORT_MATERIALIZATION_PROJECTION[family];
    assert.equal(Object.isFrozen(materializationProjection), true);
    assert.deepEqual(materializationProjection, [...materializationProjection].sort());
    assert.equal(materializationProjection.includes("LookbackPeriodInDays"), true);
    assert.equal(catalogEntry.minimumProjection.every((field) =>
      materializationProjection.includes(field)), true);
    assert.equal(materializationProjection.every((field) =>
      catalogEntry.fieldsToExport.includes(field)), true);
    assert.deepEqual(
      materializationProjection.filter((field) => !catalogEntry.minimumProjection.includes(field)),
      EXPECTED_MATERIALIZATION_ONLY_FIELDS[family],
    );
    assert.deepEqual(validateComputeOptimizerFieldsToExport(
      family,
      catalogEntry.operation,
      materializationProjection,
    ), materializationProjection);
    assert.equal(Object.isFrozen(catalogEntry.capabilityProjection), true);
    for (const projection of Object.values(catalogEntry.capabilityProjection)) {
      assert.equal(Object.isFrozen(projection), true);
      assert.equal(Object.isFrozen(projection.fields), true);
    }

    const input = [...catalogEntry.minimumProjection];
    const result = validateComputeOptimizerFieldsToExport(
      family,
      catalogEntry.operation,
      input,
    );
    assert.deepEqual(result, catalogEntry.minimumProjection);
    assert.notEqual(result, input);
    assert.equal(Object.isFrozen(result), true);
  });
}

test("the all-family materialization projection registry is immutable and exact", () => {
  assert.equal(Object.isFrozen(COMPUTE_OPTIMIZER_EXPORT_MATERIALIZATION_PROJECTION), true);
  assert.deepEqual(
    Object.keys(COMPUTE_OPTIMIZER_EXPORT_MATERIALIZATION_PROJECTION),
    COMPUTE_OPTIMIZER_EXPORT_FAMILIES,
  );
});

test("pins current official AWS API and user-guide evidence with honest discrepancies", () => {
  assert.equal(COMPUTE_OPTIMIZER_EXPORT_FIELD_EVIDENCE.retrievedOn, "2026-08-02");
  assert.match(COMPUTE_OPTIMIZER_EXPORT_FIELD_EVIDENCE.userGuideUrl, /^https:\/\/docs\.aws\.amazon\.com\//u);
  assert.equal(Object.isFrozen(COMPUTE_OPTIMIZER_EXPORT_FIELD_EVIDENCE), true);
  assert.equal(Object.isFrozen(COMPUTE_OPTIMIZER_EXPORT_FIELD_EVIDENCE.apiReferenceByFamily), true);
  assert.equal(Object.isFrozen(COMPUTE_OPTIMIZER_EXPORT_FIELD_EVIDENCE.documentedDiscrepancies), true);
  assert.equal(
    Object.keys(COMPUTE_OPTIMIZER_EXPORT_FIELD_EVIDENCE.apiReferenceByFamily).length,
    8,
  );
});

test("uses API-valid spellings instead of user-guide near misses", () => {
  const rds = COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.RDS_DATABASE.fieldsToExport;
  assert.equal(rds.includes("UtilizationMetricsStorageNetworkReceiveThroughputMaximum"), true);
  assert.equal(rds.includes("UtilizationMetricsAuroraMemoryNumDeclinedSqlTotalMaximum"), true);
  assert.equal(rds.includes("UtilizationMetricsVolumeBytesUsedAverage"), true);
  assert.equal(rds.some((field) => field.includes("\u200b")), false);
  assert.equal(rds.includes("UtilizationMetricsStorageNetworkRecieveThroughputMaximum"), false);

  assert.equal(
    COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.IDLE_RESOURCE.fieldsToExport.includes("ResourceId"),
    true,
  );
  assert.equal(
    COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.IDLE_RESOURCE.fieldsToExport.includes("ResourceID"),
    false,
  );
  assert.equal(
    COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.LICENSE.fieldsToExport.includes(
      "CurrentLicenseConfigurationNumberOfCores",
    ),
    true,
  );
  assert.equal(
    COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.AUTO_SCALING_GROUP.fieldsToExport.includes("Tags"),
    false,
  );
});

test("rejects an operation from another export family", () => {
  const catalogEntry = COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.EC2_INSTANCE;
  assert.throws(
    () => validateComputeOptimizerFieldsToExport(
      "EC2_INSTANCE",
      "ExportLambdaFunctionRecommendations",
      catalogEntry.minimumProjection,
    ),
    hasError("OPERATION_MISMATCH"),
  );
});

test("rejects cross-family and near-miss casing fields", () => {
  const catalogEntry = COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.EC2_INSTANCE;
  assert.throws(
    () => validateComputeOptimizerFieldsToExport(
      "EC2_INSTANCE",
      catalogEntry.operation,
      [...catalogEntry.minimumProjection, "FunctionArn"].sort(),
    ),
    hasError("CROSS_FAMILY_FIELD"),
  );
  assert.throws(
    () => validateComputeOptimizerFieldsToExport(
      "EC2_INSTANCE",
      catalogEntry.operation,
      [...catalogEntry.minimumProjection, "instanceArn"].sort(),
    ),
    hasError("UNKNOWN_FIELD"),
  );
});

test("rejects duplicates and non-canonical order before provider submission", () => {
  const catalogEntry = COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.EBS_VOLUME;
  assert.throws(
    () => validateComputeOptimizerFieldsToExport(
      "EBS_VOLUME",
      catalogEntry.operation,
      [...catalogEntry.minimumProjection, catalogEntry.minimumProjection.at(-1)!],
    ),
    hasError("DUPLICATE_FIELD"),
  );
  assert.throws(
    () => validateComputeOptimizerFieldsToExport(
      "EBS_VOLUME",
      catalogEntry.operation,
      [...catalogEntry.minimumProjection].reverse(),
    ),
    hasError("NON_CANONICAL_ORDER"),
  );
});

test("rejects projections that omit any evidence-honest minimum field", () => {
  const catalogEntry = COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.RDS_DATABASE;
  assert.throws(
    () => validateComputeOptimizerFieldsToExport(
      "RDS_DATABASE",
      catalogEntry.operation,
      catalogEntry.minimumProjection.filter(
        (field) => field !== "StorageRecommendationOptionsEstimatedMonthlySavingsValue",
      ),
    ),
    hasError("MINIMUM_FIELD_MISSING"),
  );
});

test("rejects malformed families and field containers", () => {
  assert.throws(
    () => validateComputeOptimizerFieldsToExport("UNKNOWN", "nope", []),
    hasError("INVALID_EXPORT_FAMILY"),
  );
  assert.throws(
    () => validateComputeOptimizerFieldsToExport(
      "IDLE_RESOURCE",
      "ExportIdleRecommendations",
      "AccountId",
    ),
    hasError("INVALID_FIELDS"),
  );
});
