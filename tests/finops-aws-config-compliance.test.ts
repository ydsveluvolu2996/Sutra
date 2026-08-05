import assert from "node:assert/strict";
import test from "node:test";

import {
  AWS_CONFIG_ACTIVITY_S3_READ_OPERATIONS,
  AWS_CONFIG_AGGREGATE_INVENTORY_QUERY,
  AWS_CONFIG_AGGREGATOR_READ_OPERATIONS,
  AWS_CONFIG_ORGANIZATION_READ_OPERATIONS,
  AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS,
  AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS,
  AwsConfigComplianceError,
  AwsConfigComplianceQueryError,
  awsConfigComplianceSourceEvidence,
  createAwsConfigComplianceQueryService,
  normalizeAwsConfigComplianceCapture,
  type AwsConfigComplianceCapture,
  type AwsConfigComplianceScope,
  type AwsConfigOperation,
} from "../lib/finops-aws-config-compliance.ts";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const ACCOUNT_ID = "123456789012";
const SCOPE: AwsConfigComplianceScope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
  partition: "aws",
  aggregatorAccountId: ACCOUNT_ID,
  aggregatorRegion: "us-east-1",
  aggregatorName: "sutra-enterprise",
  aggregatorArn:
    `arn:aws:config:us-east-1:${ACCOUNT_ID}:config-aggregator/config-aggregator-abcd1234`,
};

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[Key] extends object
      ? Mutable<T[Key]>
      : T[Key];
};

function centralCoverage(operation: AwsConfigOperation, recordCount = 1) {
  return {
    operation,
    accountId: null,
    region: null,
    state: "SUCCEEDED" as const,
    pageCount: 1,
    recordCount,
    exhausted: true,
    failureCode: null,
  };
}

function localCoverage(operation: AwsConfigOperation, recordCount = 1) {
  return {
    operation,
    accountId: ACCOUNT_ID,
    region: "us-east-1",
    state: "SUCCEEDED" as const,
    pageCount: 1,
    recordCount,
    exhausted: true,
    failureCode: null,
  };
}

function capture(): Mutable<AwsConfigComplianceCapture> {
  const sourceHash = "b".repeat(64);
  const scopeHash = "c".repeat(64);
  return {
    schemaVersion: "sutra.aws-config-compliance.v1",
    scope: { ...SCOPE },
    captureId: `config_${"d".repeat(64)}`,
    startedAt: "2026-07-31T11:50:00.000Z",
    completedAt: "2026-07-31T12:00:00.000Z",
    prerequisites: {
      serviceConfigured: true,
      aggregatorValidated: true,
      readPermissionsValidated: true,
      organizationsAllFeaturesEnabled: true,
    },
    expectedCoverage: {
      awsOrganizationId: "o-example12345",
      accountsEvidenceId: "organizations:active:20260731",
      accountsObservedAt: "2026-07-31T11:45:00.000Z",
      activeAccountIds: [ACCOUNT_ID],
      expectedRegions: ["us-east-1"],
    },
    aggregator: {
      name: SCOPE.aggregatorName,
      arn: SCOPE.aggregatorArn,
      id: "config-aggregator-abcd1234",
      sourceType: "ORGANIZATION",
      awsOrganizationId: "o-example12345",
      allAwsRegions: false,
      configuredRegions: ["us-east-1"],
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUpdatedAt: "2026-07-31T11:30:00.000Z",
    },
    operationCoverage: [
      ...AWS_CONFIG_AGGREGATOR_READ_OPERATIONS.map((operation) =>
        centralCoverage(operation, operation === "config:DescribeAggregateComplianceByConfigRules" ? 1 : 2)),
      ...AWS_CONFIG_ORGANIZATION_READ_OPERATIONS.map((operation) =>
        centralCoverage(operation)),
      ...AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS.map((operation) =>
        localCoverage(operation, 2)),
      ...AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS.map((operation) =>
        localCoverage(operation)),
    ],
    sourceStatuses: [{
      sourceType: "ORGANIZATION",
      sourceId: "o-example12345",
      accountId: null,
      region: "us-east-1",
      status: "SUCCEEDED",
      lastUpdatedAt: "2026-07-31T11:30:00.000Z",
      failureCode: null,
    }],
    recorders: [{
      accountId: ACCOUNT_ID,
      region: "us-east-1",
      recorderName: "default",
      recorderType: "CUSTOMER_MANAGED",
      servicePrincipalSha256: null,
      recording: true,
      lastStatus: "SUCCESS",
      lastStatusAt: "2026-07-31T11:40:00.000Z",
      recordAllSupported: true,
      includeGlobalResourceTypes: true,
      resourceTypes: [],
    }],
    rules: [{
      accountId: ACCOUNT_ID,
      region: "us-east-1",
      ruleName: "encrypted-volumes",
      ruleId: "config-rule-a1b2c3",
      ruleArn: `arn:aws:config:us-east-1:${ACCOUNT_ID}:config-rule/config-rule-a1b2c3`,
      state: "ACTIVE",
      owner: "AWS",
      sourceIdentifierSha256: sourceHash,
      createdBy: null,
      evaluationModes: ["DETECTIVE"],
      triggerTypes: ["CONFIGURATION_CHANGE"],
      maximumExecutionFrequency: null,
      resourceTypes: ["AWS::EC2::Volume"],
      scopeFingerprintSha256: scopeHash,
      firstActivatedAt: "2026-01-02T00:00:00.000Z",
      lastSuccessfulEvaluationAt: "2026-07-31T11:00:00.000Z",
      lastFailedEvaluationAt: null,
      lastErrorCode: null,
    }, {
      accountId: ACCOUNT_ID,
      region: "us-east-1",
      ruleName: "encrypted-volumes-copy",
      ruleId: "config-rule-d4e5f6",
      ruleArn: `arn:aws:config:us-east-1:${ACCOUNT_ID}:config-rule/config-rule-d4e5f6`,
      state: "ACTIVE",
      owner: "AWS",
      sourceIdentifierSha256: sourceHash,
      createdBy: "securityhub.amazonaws.com",
      evaluationModes: ["DETECTIVE"],
      triggerTypes: ["CONFIGURATION_CHANGE"],
      maximumExecutionFrequency: null,
      resourceTypes: ["AWS::EC2::Volume"],
      scopeFingerprintSha256: scopeHash,
      firstActivatedAt: "2026-01-02T00:00:00.000Z",
      lastSuccessfulEvaluationAt: null,
      lastFailedEvaluationAt: null,
      lastErrorCode: null,
    }],
    ruleCompliance: [{
      accountId: ACCOUNT_ID,
      region: "us-east-1",
      ruleName: "encrypted-volumes",
      complianceType: "NON_COMPLIANT",
      contributorCount: 1,
      contributorCountCapped: false,
    }],
    evaluations: [{
      accountId: ACCOUNT_ID,
      region: "us-east-1",
      ruleName: "encrypted-volumes",
      resourceType: "AWS::EC2::Volume",
      resourceId: "vol-0123456789abcdef0",
      complianceType: "NON_COMPLIANT",
      evaluationMode: "DETECTIVE",
      invokedAt: "2026-07-31T10:59:00.000Z",
      recordedAt: "2026-07-31T11:00:00.000Z",
      orderingAt: "2026-07-31T10:58:00.000Z",
      resourceEvaluationId: null,
      annotationPresent: true,
    }],
    conformancePacks: [{
      accountId: ACCOUNT_ID,
      region: "us-east-1",
      packName: "operational-best-practices",
      complianceType: "INSUFFICIENT_DATA",
      compliantRuleCount: 8,
      nonCompliantRuleCount: 1,
      totalRuleCount: 10,
    }],
    resourceCounts: [{
      accountId: ACCOUNT_ID,
      region: "us-east-1",
      resourceType: "AWS::EC2::Volume",
      resourceCount: 9,
    }],
    inventoryQuery: AWS_CONFIG_AGGREGATE_INVENTORY_QUERY,
    resourceInventory: [{
      accountId: ACCOUNT_ID,
      region: "us-east-1",
      resourceType: "AWS::EC2::Volume",
      resourceId: "vol-0123456789abcdef0",
      captureTime: "2026-07-31T11:00:00.000Z",
      creationTime: "2026-01-01T00:00:00.000Z",
      itemStatus: "ResourceDiscovered",
    }],
    activity: {
      source: "AWS_CONFIG_S3_DELIVERY",
      configured: true,
      exhausted: true,
      dataThroughAt: "2026-07-31T11:00:00.000Z",
      prefixEvidenceId: "config-prefix:sha256:abc",
      rows: [{
        day: "2026-07-31",
        accountId: ACCOUNT_ID,
        region: "us-east-1",
        ruleName: null,
        configurationItemChanges: "9007199254740993",
        ruleEvaluations: "0",
        evidenceId: "config-object:one",
        objectSha256: "e".repeat(64),
      }, {
        day: "2026-07-31",
        accountId: ACCOUNT_ID,
        region: "us-east-1",
        ruleName: "encrypted-volumes",
        configurationItemChanges: "0",
        ruleEvaluations: "9007199254740995",
        evidenceId: "config-object:two",
        objectSha256: "f".repeat(64),
      }],
    },
    cur2: {
      source: "AWS_CUR2_ACTIVE_GENERATION",
      generationId: "cur2-generation-20260731",
      sourceEvidenceId: "cur2:manifest:20260731",
      dataThroughAt: "2026-07-31T06:00:00.000Z",
      reconciliationState: "reconciled",
      predicate: "CUR2_PRODUCT_CODE_AWSCONFIG",
      rows: [{
        billingPeriod: "2026-07",
        accountId: ACCOUNT_ID,
        region: "us-east-1",
        usageType: "ConfigurationItemRecorded",
        operation: "ConfigItem",
        currency: "USD",
        billedCostMicros: "12345678901234567890",
        amortizedCostMicros: "12345678901234567890",
      }, {
        billingPeriod: "2026-07",
        accountId: ACCOUNT_ID,
        region: "us-east-1",
        usageType: "RuleEvaluation",
        operation: "ConfigRule",
        currency: "USD",
        billedCostMicros: "-34567890",
        amortizedCostMicros: "-34567890",
      }],
    },
  };
}

test("declares the exact bounded read contracts", () => {
  assert.deepEqual(AWS_CONFIG_AGGREGATOR_READ_OPERATIONS, [
    "config:DescribeConfigurationAggregators",
    "config:DescribeConfigurationAggregatorSourcesStatus",
    "config:DescribeAggregateComplianceByConfigRules",
    "config:GetAggregateComplianceDetailsByConfigRule",
    "config:DescribeAggregateComplianceByConformancePacks",
    "config:GetAggregateDiscoveredResourceCounts",
    "config:SelectAggregateResourceConfig",
  ]);
  assert.deepEqual(AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS, [
    "config:DescribeConfigRules",
    "config:DescribeConfigRuleEvaluationStatus",
  ]);
  assert.deepEqual(AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS, [
    "config:DescribeConfigurationRecorders",
    "config:DescribeConfigurationRecorderStatus",
  ]);
  assert.deepEqual(AWS_CONFIG_ORGANIZATION_READ_OPERATIONS, [
    "organizations:DescribeOrganization",
    "organizations:ListAccounts",
  ]);
  assert.deepEqual(AWS_CONFIG_ACTIVITY_S3_READ_OPERATIONS, [
    "s3:GetBucketLocation", "s3:GetObject", "s3:GetObjectAttributes", "s3:ListBucket",
  ]);
});

test("normalizes complete organization compliance, lifecycle, activity, and exact actual cost", () => {
  const snapshot = normalizeAwsConfigComplianceCapture(capture(), SCOPE, NOW.getTime());
  assert.equal(snapshot.state, "READY");
  assert.deepEqual(snapshot.channelStates, {
    aggregatorCompliance: "READY",
    ruleLifecycle: "READY",
    configurationActivity: "READY",
    actualCost: "READY",
  });
  assert.equal(snapshot.organizationCoverage.status, "COMPLETE");
  assert.equal(snapshot.organizationCoverage.recordingAccountRegionCount, 1);
  assert.equal(snapshot.counts.rules, 2);
  assert.equal(snapshot.counts.nonCompliantRules, 1);
  assert.equal(snapshot.counts.rulesWithoutResults, 1);
  assert.equal(snapshot.counts.nonCompliantResources, 1);
  assert.equal(snapshot.counts.insufficientDataPacks, 1);
  assert.equal(snapshot.counts.duplicateRuleDeployments, 2);
  assert.equal(snapshot.counts.discoveredResources, "9");
  assert.equal(snapshot.rules[1]?.lifecycle, "NEVER_EVALUATED");
  assert.equal(snapshot.activity.configurationItemChanges, "9007199254740993");
  assert.equal(snapshot.activity.ruleEvaluations, "9007199254740995");
  assert.deepEqual(snapshot.actualCosts, [{
    currency: "USD",
    billedCostMicros: "12345678901200000000",
    amortizedCostMicros: "12345678901200000000",
    rowCount: 2,
  }]);
  assert.match(snapshot.limitations.join(" "), /never allocated to individual rules/iu);

  const evidence = awsConfigComplianceSourceEvidence(snapshot);
  assert.equal(evidence.sourceId, "aws_config_organization_aggregator");
  assert.equal(evidence.coverage.assessment, "complete");
  assert.equal(evidence.lastAttemptOutcome, "succeeded");
});

test("rejects tenant, connection, aggregator, account, and Region substitution", () => {
  const expectedScopes: AwsConfigComplianceScope[] = [
    { ...SCOPE, orgId: "org_attacker" },
    { ...SCOPE, customerId: "customer_attacker" },
    { ...SCOPE, connectionId: `conn_${"9".repeat(32)}` },
    { ...SCOPE, aggregatorName: "other" },
  ];
  for (const expected of expectedScopes) {
    assert.throws(
      () => normalizeAwsConfigComplianceCapture(capture(), expected, NOW.getTime()),
      (error) => error instanceof AwsConfigComplianceError && error.code === "SCOPE_MISMATCH",
    );
  }
  const wrongAccount = capture();
  wrongAccount.rules[0]!.accountId = "999988887777";
  assert.throws(
    () => normalizeAwsConfigComplianceCapture(wrongAccount, SCOPE, NOW.getTime()),
    (error) => error instanceof AwsConfigComplianceError && error.code === "SCOPE_MISMATCH",
  );
});

test("marks capped contributor evidence and missing account-Region coverage partial", () => {
  const sample = capture();
  sample.ruleCompliance[0]!.contributorCountCapped = true;
  sample.operationCoverage = sample.operationCoverage.filter((item) =>
    item.operation !== "config:DescribeConfigurationRecorderStatus");
  const snapshot = normalizeAwsConfigComplianceCapture(sample, SCOPE, NOW.getTime());
  assert.equal(snapshot.state, "PARTIAL");
  assert.equal(snapshot.channelStates.aggregatorCompliance, "PARTIAL");
  assert.equal(snapshot.organizationCoverage.status, "PARTIAL");
  assert.equal(snapshot.organizationCoverage.missingAccountRegions.length, 1);
  assert.match(snapshot.limitations.join(" "), /contributor count is capped/iu);
});

test("fails closed when exact uncapped contributor detail is missing", () => {
  const sample = capture();
  sample.evaluations = [];
  assert.throws(
    () => normalizeAwsConfigComplianceCapture(sample, SCOPE, NOW.getTime()),
    (error) => error instanceof AwsConfigComplianceError && error.code === "INCOMPLETE_EVIDENCE",
  );
});

test("deduplicates identical rollups and rejects conflicting or future evidence", () => {
  const duplicate = capture();
  duplicate.activity = {
    ...duplicate.activity!,
    rows: [...duplicate.activity!.rows, { ...duplicate.activity!.rows[0]! }],
  };
  duplicate.cur2 = {
    ...duplicate.cur2!,
    rows: [...duplicate.cur2!.rows, { ...duplicate.cur2!.rows[0]! }],
  };
  const snapshot = normalizeAwsConfigComplianceCapture(duplicate, SCOPE, NOW.getTime());
  assert.equal(snapshot.activity.rows.length, 2);
  assert.equal(snapshot.actualCosts[0]?.rowCount, 2);

  const conflicting = capture();
  conflicting.cur2 = {
    ...conflicting.cur2!,
    rows: [...conflicting.cur2!.rows, {
      ...conflicting.cur2!.rows[0]!,
      billedCostMicros: "999",
    }],
  };
  assert.throws(
    () => normalizeAwsConfigComplianceCapture(conflicting, SCOPE, NOW.getTime()),
    (error) => error instanceof AwsConfigComplianceError && error.code === "CONFLICTING_DUPLICATE",
  );

  const future = capture();
  future.activity = {
    ...future.activity!,
    rows: [{ ...future.activity!.rows[0]!, day: "2026-08-01" }, ...future.activity!.rows.slice(1)],
  };
  assert.throws(
    () => normalizeAwsConfigComplianceCapture(future, SCOPE, NOW.getTime()),
    (error) => error instanceof AwsConfigComplianceError && error.code === "INVALID_INPUT",
  );
});

test("reports stale captures without changing retained AWS evidence", () => {
  const later = Date.parse("2026-08-04T12:00:00.000Z");
  const snapshot = normalizeAwsConfigComplianceCapture(capture(), SCOPE, later);
  assert.equal(snapshot.state, "STALE");
  assert.equal(snapshot.channelStates.aggregatorCompliance, "STALE");
  assert.equal(snapshot.channelStates.ruleLifecycle, "STALE");
  assert.equal(snapshot.counts.nonCompliantRules, 1);
});

test("reports configuration required and partial cost channels honestly", () => {
  const missing = capture();
  missing.prerequisites.serviceConfigured = false;
  missing.aggregator = null;
  assert.equal(
    normalizeAwsConfigComplianceCapture(missing, SCOPE, NOW.getTime()).state,
    "CONFIGURATION_REQUIRED",
  );

  const partialCost = capture();
  partialCost.cur2 = { ...partialCost.cur2!, reconciliationState: "partial" };
  const snapshot = normalizeAwsConfigComplianceCapture(partialCost, SCOPE, NOW.getTime());
  assert.equal(snapshot.state, "PARTIAL");
  assert.equal(snapshot.channelStates.actualCost, "PARTIAL");
});

test("represents an exhaustive empty environment as empty, not failed or compliant", () => {
  const sample = capture();
  sample.rules = [];
  sample.ruleCompliance = [];
  sample.evaluations = [];
  sample.conformancePacks = [];
  sample.resourceCounts = [];
  sample.resourceInventory = [];
  sample.activity = { ...sample.activity!, rows: [] };
  sample.cur2 = { ...sample.cur2!, rows: [] };
  const snapshot = normalizeAwsConfigComplianceCapture(sample, SCOPE, NOW.getTime());
  assert.equal(snapshot.state, "EMPTY");
  assert.equal(snapshot.channelStates.aggregatorCompliance, "EMPTY");
  assert.equal(snapshot.counts.rules, 0);
  assert.match(snapshot.limitations.join(" "), /missing rules or resources/iu);
});

test("rejects raw or unmodeled sensitive fields at the broker boundary", () => {
  const sample = capture() as Mutable<AwsConfigComplianceCapture> & {
    providerErrorMessage?: string;
  };
  sample.providerErrorMessage = "raw provider message";
  assert.throws(
    () => normalizeAwsConfigComplianceCapture(sample, SCOPE, NOW.getTime()),
    (error) => error instanceof AwsConfigComplianceError && error.code === "SENSITIVE_DATA_REJECTED",
  );

  const rawAnnotation = capture();
  (rawAnnotation.evaluations[0] as typeof rawAnnotation.evaluations[0] & { annotation?: string }).annotation = "secret";
  assert.throws(
    () => normalizeAwsConfigComplianceCapture(rawAnnotation, SCOPE, NOW.getTime()),
    (error) => error instanceof AwsConfigComplianceError && error.code === "SENSITIVE_DATA_REJECTED",
  );
});

test("query service sends only pinned scope, operations, query, and bounds", async () => {
  let observed = false;
  const service = createAwsConfigComplianceQueryService(SCOPE, {
    async collect(request) {
      observed = true;
      assert.deepEqual(request.scope, SCOPE);
      assert.deepEqual(request.aggregatorOperations, AWS_CONFIG_AGGREGATOR_READ_OPERATIONS);
      assert.deepEqual(request.lifecycleOperations, AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS);
      assert.deepEqual(request.recorderOperations, AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS);
      assert.deepEqual(request.organizationOperations, AWS_CONFIG_ORGANIZATION_READ_OPERATIONS);
      assert.equal(request.inventoryQuery, AWS_CONFIG_AGGREGATE_INVENTORY_QUERY);
      return capture();
    },
  }, () => NOW.getTime());
  const snapshot = await service.query();
  assert.equal(observed, true);
  assert.equal(snapshot.state, "READY");

  await assert.rejects(
    createAwsConfigComplianceQueryService(SCOPE, { collect: async () => { throw new Error("offline"); } }).query(),
    (error) => error instanceof AwsConfigComplianceQueryError && error.code === "SOURCE_UNAVAILABLE",
  );
  const invalid = capture();
  invalid.scope.orgId = "org_attacker";
  await assert.rejects(
    createAwsConfigComplianceQueryService(SCOPE, { collect: async () => invalid }, () => NOW.getTime()).query(),
    (error) => error instanceof AwsConfigComplianceQueryError && error.code === "INVALID_EVIDENCE",
  );
});
