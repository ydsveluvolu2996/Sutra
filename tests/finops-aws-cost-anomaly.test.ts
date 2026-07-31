import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAwsCostAnomalySourceEvidence,
  buildCostAnomalyDashboard,
  CostAnomalyBoundaryError,
  CostAnomalyQueryServiceError,
  createCostAnomalyQueryService,
  parseAwsCostAnomalyCollection,
  type CostAnomalyBrokerRequest,
} from "../lib/finops-aws-cost-anomaly.ts";
import { ANOMALY_DISCLAIMER } from "../lib/finops-insights.ts";

const ACCOUNT_ID = "123456789012";
const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const MONITOR_ARN =
  `arn:aws:ce::${ACCOUNT_ID}:anomalymonitor/monitor-1`;
const SUBSCRIPTION_ARN =
  `arn:aws:ce::${ACCOUNT_ID}:anomalysubscription/subscription-1`;
const NOW = new Date("2026-07-31T12:00:00.000Z");

function collection(): Record<string, unknown> {
  return {
    schemaVersion: "sutra.aws-cost-anomaly-detection.v1",
    source: "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION",
    status: "COMPLETE",
    accountId: ACCOUNT_ID,
    collectedAt: "2026-07-31T10:00:00.000Z",
    windowStartDate: "2026-07-01",
    windowEndDate: "2026-07-31",
    dataThroughAt: "2026-07-31T04:30:00.000Z",
    coverage: [
      {
        operation: "GET_ANOMALIES",
        status: "SUCCEEDED",
        pagesObserved: 1,
        recordsObserved: 1,
        recordsAccepted: 1,
        recordsRejected: 0,
        recordsOmitted: 0,
        errorCode: null,
      },
      {
        operation: "GET_ANOMALY_MONITORS",
        status: "SUCCEEDED",
        pagesObserved: 1,
        recordsObserved: 1,
        recordsAccepted: 1,
        recordsRejected: 0,
        recordsOmitted: 0,
        errorCode: null,
      },
      {
        operation: "GET_ANOMALY_SUBSCRIPTIONS",
        status: "SUCCEEDED",
        pagesObserved: 1,
        recordsObserved: 1,
        recordsAccepted: 1,
        recordsRejected: 0,
        recordsOmitted: 0,
        errorCode: null,
      },
    ],
    anomalies: [{
      anomalyId: "anomaly-1",
      monitorArn: MONITOR_ARN,
      startDate: "2026-07-20",
      endDate: "2026-07-21",
      dimensionValue: "Amazon Elastic Compute Cloud - Compute",
      feedback: "PLANNED_ACTIVITY",
      score: { current: 72, maximum: 91 },
      impact: {
        maximum: 140,
        total: 200,
        actualSpend: 500,
        expectedSpend: 300,
        percentage: 66.67,
      },
      rootCauses: [{
        service: "Amazon Elastic Compute Cloud - Compute",
        region: "us-east-1",
        linkedAccountId: "210987654321",
        linkedAccountName: "payments-production",
        usageType: "BoxUsage:m7g.large",
        contribution: 180,
      }],
      rootCausesOmitted: 0,
    }],
    monitors: [{
      monitorArn: MONITOR_ARN,
      name: "Service monitor",
      type: "DIMENSIONAL",
      dimension: "SERVICE",
      specificationPresent: false,
      dimensionalValueCount: 25,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUpdatedAt: "2026-07-30T02:00:00.000Z",
      lastEvaluatedAt: "2026-07-31T04:30:00.000Z",
    }],
    subscriptions: [{
      subscriptionArn: SUBSCRIPTION_ARN,
      name: "Finance daily",
      frequency: "DAILY",
      monitorArns: [MONITOR_ARN],
      monitorArnsOmitted: 0,
      threshold: 100,
      thresholdExpressionPresent: true,
      subscriberCounts: {
        emailConfirmed: 1,
        emailDeclined: 0,
        snsConfirmed: 0,
        snsDeclined: 0,
        unknown: 0,
      },
    }],
    limitations: [
      "SUBSCRIBER_ADDRESSES_REDACTED",
      "RAW_MONITOR_AND_THRESHOLD_EXPRESSIONS_NOT_RETAINED",
      "AWS_PROVIDER_FINDINGS_SEPARATE_FROM_SUTRA_STATISTICAL_SIGNALS",
    ],
  };
}

test("accepts the exact signed-broker contract and rejects cross-account or expanded payloads", () => {
  const parsed = parseAwsCostAnomalyCollection(
    collection(),
    ACCOUNT_ID,
    NOW,
  );
  assert.equal(parsed.anomalies[0]?.impact.total, 200);
  assert.equal(parsed.monitors[0]?.lastEvaluatedAt, parsed.dataThroughAt);

  assert.throws(
    () => parseAwsCostAnomalyCollection(
      collection(),
      "999988887777",
      NOW,
    ),
    (error) => error instanceof CostAnomalyBoundaryError,
  );
  assert.throws(
    () => parseAwsCostAnomalyCollection(
      { ...collection(), temporaryCredentials: "must-not-cross-boundary" },
      ACCOUNT_ID,
      NOW,
    ),
    (error) => error instanceof CostAnomalyBoundaryError,
  );
});

test("rejects inconsistent completeness and accepted-record evidence", () => {
  const value = collection();
  const coverage = structuredClone(
    value.coverage as Array<Record<string, unknown>>,
  );
  coverage[0]!.recordsAccepted = 0;
  assert.throws(
    () => parseAwsCostAnomalyCollection(
      { ...value, coverage },
      ACCOUNT_ID,
      NOW,
    ),
    (error) => error instanceof CostAnomalyBoundaryError,
  );

  coverage[0]!.recordsObserved = 0;
  coverage[0]!.status = "PARTIAL";
  coverage[0]!.errorCode = "RECORD_LIMIT_REACHED";
  assert.throws(
    () => parseAwsCostAnomalyCollection(
      { ...value, status: "COMPLETE", coverage },
      ACCOUNT_ID,
      NOW,
    ),
    (error) => error instanceof CostAnomalyBoundaryError,
  );
});

test("tenant-pinned query service derives scope and dates internally", async () => {
  const requests: CostAnomalyBrokerRequest[] = [];
  const service = createCostAnomalyQueryService({
    scope: {
      orgId: "org_alpha",
      customerId: "customer_alpha",
      connectionId: CONNECTION_ID,
    },
    accountId: ACCOUNT_ID,
    partition: "aws",
  }, {
    async collect(request) {
      requests.push(request);
      return collection();
    },
  }, {
    now: () => NOW,
    createJobId: () => `cad_${"b".repeat(32)}`,
  });

  const result = await service.query({ lookbackDays: 30 });
  assert.equal(result.accountId, ACCOUNT_ID);
  assert.deepEqual(requests, [{
    tenantId: "org_alpha",
    connectionId: CONNECTION_ID,
    jobId: `cad_${"b".repeat(32)}`,
    windowStartDate: "2026-07-01",
    windowEndDate: "2026-07-31",
  }]);
  await assert.rejects(
    service.query({
      lookbackDays: 30,
      tenantId: "org_attacker",
    }),
    (error) =>
      error instanceof CostAnomalyQueryServiceError
      && error.code === "INVALID_QUERY",
  );
});

test("separate tenant services share no request scope or cache state", async () => {
  const requests: CostAnomalyBrokerRequest[] = [];
  const transport = {
    async collect(request: CostAnomalyBrokerRequest) {
      requests.push(request);
      return collection();
    },
  };
  const fixedDependencies = {
    now: () => NOW,
    createJobId: () => `cad_${"c".repeat(32)}`,
  };
  const alpha = createCostAnomalyQueryService({
    scope: {
      orgId: "org_alpha",
      customerId: "customer_alpha",
      connectionId: CONNECTION_ID,
    },
    accountId: ACCOUNT_ID,
    partition: "aws",
  }, transport, fixedDependencies);
  const beta = createCostAnomalyQueryService({
    scope: {
      orgId: "org_beta",
      customerId: "customer_beta",
      connectionId: `conn_${"d".repeat(32)}`,
    },
    accountId: ACCOUNT_ID,
    partition: "aws",
  }, transport, fixedDependencies);

  await alpha.query({});
  await beta.query({});
  assert.deepEqual(
    requests.map((request) => [
      request.tenantId,
      request.connectionId,
    ]),
    [
      ["org_alpha", CONNECTION_ID],
      ["org_beta", `conn_${"d".repeat(32)}`],
    ],
  );
});

test("query service converts transport failures to a generic client-safe error", async () => {
  const service = createCostAnomalyQueryService({
    scope: {
      orgId: "org_alpha",
      customerId: "customer_alpha",
      connectionId: CONNECTION_ID,
    },
    accountId: ACCOUNT_ID,
    partition: "aws",
  }, {
    async collect() {
      throw new Error("sensitive provider request identifier");
    },
  }, {
    now: () => NOW,
    createJobId: () => `cad_${"e".repeat(32)}`,
  });

  await assert.rejects(
    service.query({}),
    (error) => {
      assert.ok(error instanceof CostAnomalyQueryServiceError);
      assert.equal(error.code, "COLLECTION_FAILED");
      assert.equal(error.message.includes("sensitive"), false);
      return true;
    },
  );
});

test("query service rejects a signed response for a different requested window", async () => {
  const service = createCostAnomalyQueryService({
    scope: {
      orgId: "org_alpha",
      customerId: "customer_alpha",
      connectionId: CONNECTION_ID,
    },
    accountId: ACCOUNT_ID,
    partition: "aws",
  }, {
    async collect() {
      return {
        ...collection(),
        windowStartDate: "2026-07-02",
      };
    },
  }, {
    now: () => NOW,
    createJobId: () => `cad_${"f".repeat(32)}`,
  });

  await assert.rejects(
    service.query({ lookbackDays: 30 }),
    (error) =>
      error instanceof CostAnomalyQueryServiceError
      && error.code === "COLLECTION_FAILED",
  );
});

test("AWS provider anomalies and Sutra statistical findings remain explicitly separate", () => {
  const parsed = parseAwsCostAnomalyCollection(
    collection(),
    ACCOUNT_ID,
    NOW,
  );
  const dashboard = buildCostAnomalyDashboard(parsed, {
    anomalies: [{
      dateIso: "2026-07-20",
      service: "AmazonEC2",
      currency: "USD",
      amountMicros: "90000000",
      baselineMicros: "10000000",
      ratio: 9,
    }],
    evaluatedDays: 30,
    disclaimer: ANOMALY_DISCLAIMER,
  });

  assert.equal(
    dashboard.aws.source,
    "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION",
  );
  assert.equal(
    dashboard.sutra.source,
    "SUTRA_STATISTICAL_BILLING_SIGNALS",
  );
  assert.match(dashboard.sutra.disclaimer, /not an AWS Cost Anomaly/u);
  assert.match(dashboard.disclaimer, /independent sources/u);
});

test("projects explicit source readiness from accepted signed-broker evidence", () => {
  const parsed = parseAwsCostAnomalyCollection(
    collection(),
    ACCOUNT_ID,
    NOW,
  );
  const evidence = buildAwsCostAnomalySourceEvidence({
    orgId: "org_alpha",
    customerId: "customer_alpha",
    connectionId: CONNECTION_ID,
  }, parsed);

  assert.equal(evidence.sourceId, "cost_anomaly_detection");
  assert.equal(evidence.configured, true);
  assert.equal(evidence.deliveryObserved, true);
  assert.equal(evidence.coverage.assessment, "complete");
  assert.equal(evidence.coverage.acceptedRecords, 3);
  assert.equal(evidence.dataThroughAt, "2026-07-31T04:30:00.000Z");
  assert.match(evidence.evidenceBasis, /ce:GetAnomalies/u);
});
