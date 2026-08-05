import assert from "node:assert/strict";
import test from "node:test";
import {
  AWS_CONFIG_COMPLIANCE_JOB_KIND,
  AwsConfigComplianceJobError,
  runAwsConfigComplianceCollectionJob,
  type AwsConfigComplianceCollectorRequest,
} from "../lib/finops-aws-config-compliance-job.ts";
import type {
  AwsConfigComplianceCapture,
  AwsConfigComplianceScope,
} from "../lib/finops-aws-config-compliance.ts";

const CONNECTION = `conn_${"a".repeat(32)}`;
const scope: AwsConfigComplianceScope = {
  orgId: "org_a",
  customerId: "customer_a",
  connectionId: CONNECTION,
  partition: "aws",
  aggregatorAccountId: "111122223333",
  aggregatorRegion: "us-east-1",
  aggregatorName: "org-aggregator",
  aggregatorArn: "arn:aws:config:us-east-1:111122223333:config-aggregator/config-aggregator-abc123",
};
const capture: AwsConfigComplianceCapture = {
  schemaVersion: "sutra.aws-config-compliance.v1",
  scope,
  captureId: `config_${"b".repeat(64)}`,
  startedAt: "2026-08-01T00:00:00.000Z",
  completedAt: "2026-08-01T00:01:00.000Z",
  prerequisites: {
    serviceConfigured: false,
    aggregatorValidated: false,
    readPermissionsValidated: false,
    organizationsAllFeaturesEnabled: true,
  },
  expectedCoverage: {
    awsOrganizationId: "o-1234567890",
    accountsEvidenceId: "organizations-ledger",
    accountsObservedAt: "2026-08-01T00:00:00.000Z",
    activeAccountIds: ["111122223333"],
    expectedRegions: ["us-east-1"],
  },
  aggregator: null,
  operationCoverage: [],
  sourceStatuses: [],
  recorders: [],
  rules: [],
  ruleCompliance: [],
  evaluations: [],
  conformancePacks: [],
  resourceCounts: [],
  inventoryQuery: "SELECT accountId, awsRegion, resourceType, resourceId, configurationItemCaptureTime, resourceCreationTime, configurationItemStatus",
  resourceInventory: [],
  activity: null,
  cur2: null,
};

function job() {
  return {
    id: "job_a",
    orgId: scope.orgId,
    customerId: scope.customerId,
    connectionId: scope.connectionId,
    kind: AWS_CONFIG_COMPLIANCE_JOB_KIND,
    payload: { scheduledWindow: "2026-08-01T00:00:00.000Z" },
  };
}

test("AWS Config job pins operations, evidence sources, privacy, bounds and tenant scope", async () => {
  const requests: AwsConfigComplianceCollectorRequest[] = [];
  const result = await runAwsConfigComplianceCollectionJob(job(), {
    loadScope: async () => scope,
    adapter: {
      collect: async (value) => {
        requests.push(value);
        return capture;
      },
    },
    store: {
      recordSnapshot: async (storedScope, snapshot) => ({
        scope: storedScope,
        snapshotId: `acc_${"c".repeat(64)}`,
        contentSha256: "c".repeat(64),
        state: snapshot.state,
        capturedAt: snapshot.capturedAt,
        createdAtIso: snapshot.capturedAt,
        snapshot,
      }),
    },
    now: () => Date.parse(capture.completedAt),
  });
  assert.equal(result.captureId, capture.captureId);
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.cur2Source, "ACTIVE_RECONCILED_CUR2_GENERATION");
  assert.equal(request.activityObjectPolicy, "SERVER_PINNED_EXACT_PREFIX_OR_UNAVAILABLE");
  assert.equal(request.includeRawProviderMessages, false);
  assert.equal(request.includeCredentialMaterial, false);
  assert.match(JSON.stringify(request), /DescribeAggregateComplianceByConfigRules/u);
  assert.doesNotMatch(JSON.stringify(request), /PutConfigRule|StartConfigurationRecorder/u);
});

test("AWS Config job rejects payload, trusted-scope and returned-scope substitution", async () => {
  const dependencies = {
    loadScope: async () => scope,
    adapter: { collect: async () => capture },
    store: {
      recordSnapshot: async () => { throw new Error("must not persist"); },
    },
    now: () => Date.parse(capture.completedAt),
  };
  await assert.rejects(
    runAwsConfigComplianceCollectionJob({ ...job(), payload: { scheduledWindow: "now", orgId: "attacker" } }, dependencies),
    AwsConfigComplianceJobError,
  );
  await assert.rejects(
    runAwsConfigComplianceCollectionJob(job(), {
      ...dependencies,
      loadScope: async () => ({ ...scope, customerId: "customer_attacker" }),
    }),
    (error) => error instanceof AwsConfigComplianceJobError && !/must not persist/u.test(error.message),
  );
  await assert.rejects(
    runAwsConfigComplianceCollectionJob(job(), {
      ...dependencies,
      adapter: { collect: async () => ({ ...capture, scope: { ...scope, orgId: "org_attacker" } }) },
    }),
    (error) => error instanceof Error && !/must not persist/u.test(error.message),
  );
});
