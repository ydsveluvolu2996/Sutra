import assert from "node:assert/strict";
import test from "node:test";

import {
  AWS_BUDGETS_DEPENDENT_IAM_ACTIONS,
  AWS_BUDGETS_ORGANIZATION_READ_IAM_ACTIONS,
  AWS_BUDGETS_READ_API_OPERATIONS,
  AWS_BUDGETS_READ_IAM_ACTIONS,
  AwsBudgetsOrganizationError,
  awsBudgetsOrganizationSourceEvidence,
  buildAwsBudgetsOrganizationDashboard,
  normalizeAwsBudgetsCapture,
  type AwsBudgetsCapture,
  type AwsBudgetsScope,
  type AwsOrganizationHierarchyEvidence,
} from "../lib/finops-aws-budgets-organization.ts";
import type { FinopsOrganizationTaxonomy } from "../lib/finops-cost-intelligence.ts";

const ACCOUNT_ID = "123456789012";
const LINKED_ACCOUNT_ID = "210987654321";
const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const SCOPE: AwsBudgetsScope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
  accountId: ACCOUNT_ID,
  partition: "aws",
};

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? Mutable<U>[]
    : T[K] extends object ? Mutable<T[K]> : T[K];
};

const costTypes = {
  includeCredit: true,
  includeDiscount: true,
  includeOtherSubscription: true,
  includeRecurring: true,
  includeRefund: true,
  includeSubscription: true,
  includeSupport: true,
  includeTax: true,
  includeUpfront: true,
  useAmortized: false,
  useBlended: false,
};

const notification = {
  comparisonOperator: "GREATER_THAN" as const,
  notificationType: "FORECASTED" as const,
  threshold: "90",
  thresholdType: "PERCENTAGE" as const,
};

function page<T>(records: T[], nextToken: string | null = null) {
  return {
    request: { accountId: ACCOUNT_ID, maxResults: 100 as const, nextToken: null },
    response: { records, nextToken },
  };
}

function capture(): Mutable<AwsBudgetsCapture> {
  return {
    schemaVersion: "sutra.aws-budgets-organization.v1",
    scope: { ...SCOPE },
    captureId: `awsbudgets_${"b".repeat(64)}`,
    startedAtIso: "2026-07-31T11:55:00.000Z",
    completedAtIso: "2026-07-31T12:00:00.000Z",
    operationCoverage: [
      { operation: "DescribeBudgets", state: "SUCCEEDED", recordCount: 1, failureCode: null },
      { operation: "DescribeBudgetPerformanceHistory", state: "SUCCEEDED", recordCount: 1, failureCode: null },
      { operation: "DescribeNotificationsForBudget", state: "SUCCEEDED", recordCount: 1, failureCode: null },
      { operation: "DescribeSubscribersForNotification", state: "SUCCEEDED", recordCount: 2, failureCode: null },
      { operation: "DescribeBudgetActionsForBudget", state: "SUCCEEDED", recordCount: 1, failureCode: null },
    ],
    budgetPages: [page([{
      budgetName: "Platform monthly guardrail",
      budgetType: "COST",
      timeUnit: "MONTHLY",
      timePeriod: {
        start: "2026-07-01T00:00:00.000Z",
        end: "2026-08-01T00:00:00.000Z",
      },
      budgetLimit: { amount: "10000", unit: "USD" },
      plannedBudgetLimits: {},
      calculatedSpend: {
        actualSpend: { amount: "6250.25", unit: "USD" },
        forecastedSpend: { amount: "10100.50", unit: "USD" },
      },
      costFilters: { LinkedAccount: [LINKED_ACCOUNT_ID], Service: ["AmazonEC2"] },
      costTypes,
      metrics: ["UnblendedCost"],
      lastUpdatedAt: "2026-07-31T11:00:00.000Z",
    }])],
    historySequences: [{
      budgetName: "Platform monthly guardrail",
      pages: [page([{
        timePeriod: {
          start: "2026-07-01T00:00:00.000Z",
          end: "2026-08-01T00:00:00.000Z",
        },
        budgetedAmount: { amount: "10000", unit: "USD" },
        actualAmount: { amount: "6250.25", unit: "USD" },
        forecastedAmount: { amount: "10100.50", unit: "USD" },
      }])],
    }],
    notificationSequences: [{
      budgetName: "Platform monthly guardrail",
      pages: [page([notification])],
    }],
    subscriberSequences: [{
      budgetName: "Platform monthly guardrail",
      notification,
      pages: [page([{ subscriptionType: "EMAIL" }, { subscriptionType: "SNS" }])],
    }],
    actionSequences: [{
      budgetName: "Platform monthly guardrail",
      pages: [page([{
        actionId: "action-001",
        actionType: "APPLY_SCP_POLICY",
        approvalModel: "MANUAL",
        notificationType: "FORECASTED",
        status: "STANDBY",
        threshold: "100",
        thresholdType: "PERCENTAGE",
        executionRolePresent: true,
        targetedResourceCount: 1,
      }])],
    }],
  };
}

function hierarchy(): AwsOrganizationHierarchyEvidence {
  return {
    scope: SCOPE,
    sourceEvidenceId: "aws_org_capture_20260731",
    observedAtIso: "2026-07-31T11:30:00.000Z",
    state: "complete",
    accounts: [{
      accountId: LINKED_ACCOUNT_ID,
      accountName: "Payments production",
      parentId: "ou-platform",
      ouPath: ["Root", "Platform", "Production"],
    }],
  };
}

function taxonomy(): FinopsOrganizationTaxonomy {
  return {
    scope: {
      organizationId: SCOPE.orgId,
      customerId: SCOPE.customerId,
      connectionId: SCOPE.connectionId,
    },
    evidence: {
      source: "operator_map",
      sourceEvidenceId: "taxonomy_capture_20260731",
      observedAtIso: "2026-07-31T11:40:00.000Z",
    },
    allowLists: {
      company: ["Sutra"],
      business_unit: ["Platform"],
      environment: ["production"],
      cost_center: ["CC-101"],
      account: [LINKED_ACCOUNT_ID],
    },
    assignments: [{
      accountId: LINKED_ACCOUNT_ID,
      company: "Sutra",
      businessUnit: "Platform",
      environment: "production",
      costCenter: "CC-101",
      owner: "platform-finops",
    }],
  };
}

test("normalizes authoritative definitions, spend, history, alerts, subscribers, and read-only actions", () => {
  const snapshot = normalizeAwsBudgetsCapture(capture(), SCOPE, NOW);
  assert.equal(snapshot.collectionState, "ready");
  assert.equal(snapshot.freshness.status, "fresh");
  assert.equal(snapshot.budgets.length, 1);
  const budget = snapshot.budgets[0]!;
  assert.equal(budget.actual?.amountMicros, "6250250000");
  assert.equal(budget.forecast?.amountMicros, "10100500000");
  assert.equal(budget.history[0]?.budgeted.currency, "USD");
  assert.equal(budget.notifications[0]?.subscriberCount, 2);
  assert.deepEqual(budget.notifications[0]?.subscriberTypes, ["EMAIL", "SNS"]);
  assert.deepEqual(budget.actions[0], {
    actionId: "action-001",
    actionType: "APPLY_SCP_POLICY",
    approvalModel: "MANUAL",
    notificationType: "FORECASTED",
    status: "STANDBY",
    threshold: "100",
    thresholdType: "PERCENTAGE",
    executionRolePresent: true,
    targetedResourceCount: 1,
  });
  const source = awsBudgetsOrganizationSourceEvidence(snapshot);
  assert.equal(source.sourceId, "aws_budgets");
  assert.equal(source.coverage.assessment, "complete");
  assert.equal(source.coverage.acceptedRecords, 1);
  assert.equal(source.coverage.expectedRecords, 1);
  assert.equal(source.dataThroughAt, "2026-07-31T11:00:00.000Z");
});

test("projects linked accounts through AWS OU and canonical business taxonomy evidence", () => {
  const snapshot = normalizeAwsBudgetsCapture(capture(), SCOPE, NOW);
  const dashboard = buildAwsBudgetsOrganizationDashboard({
    snapshot,
    hierarchy: hierarchy(),
    taxonomy: taxonomy(),
    nowEpochMs: NOW,
  });
  assert.equal(dashboard.state, "ready");
  assert.equal(dashboard.coverage.totalAwsBudgets, 1);
  assert.equal(dashboard.coverage.matchedAwsBudgets, 1);
  assert.deepEqual(dashboard.coverage.currencies, ["USD"]);
  assert.equal(dashboard.budgets[0]?.targeting, "linked_accounts");
  assert.deepEqual(dashboard.budgets[0]?.accountMappings[0], {
    accountId: LINKED_ACCOUNT_ID,
    accountName: "Payments production",
    parentId: "ou-platform",
    ouPath: ["Root", "Platform", "Production"],
    company: "Sutra",
    businessUnit: "Platform",
    environment: "production",
    costCenter: "CC-101",
    owner: "platform-finops",
    coverage: "complete",
  });
  assert.deepEqual(dashboard.internalSutraBudgets, {
    source: "SUTRA_INTERNAL_BUDGETS",
    included: false,
    reason: "Sutra-authored budgets use a separate repository and evidence lineage; they are not AWS Budgets records.",
  });
});

test("rejects organization, customer, connection, account, and partition substitution", () => {
  const replacements: AwsBudgetsScope[] = [
    { ...SCOPE, orgId: "org_attacker" },
    { ...SCOPE, customerId: "customer_attacker" },
    { ...SCOPE, connectionId: `conn_${"c".repeat(32)}` },
    { ...SCOPE, accountId: "999988887777" },
    { ...SCOPE, partition: "aws-us-gov" },
  ];
  for (const replacement of replacements) {
    assert.throws(
      () => normalizeAwsBudgetsCapture(capture(), replacement, NOW),
      (error) => error instanceof AwsBudgetsOrganizationError && error.code === "SCOPE_MISMATCH",
    );
  }
});

test("rejects pagination token replay and requests for the wrong AWS account", () => {
  const replay = capture();
  const first = replay.budgetPages[0]!;
  first.response.nextToken = "replayed-token";
  replay.budgetPages.push({
    request: { accountId: ACCOUNT_ID, maxResults: 100, nextToken: "replayed-token" },
    response: { records: [], nextToken: "replayed-token" },
  });
  assert.throws(
    () => normalizeAwsBudgetsCapture(replay, SCOPE, NOW),
    (error) => error instanceof AwsBudgetsOrganizationError && error.code === "INVALID_PAGINATION",
  );

  const wrongAccount = capture();
  wrongAccount.historySequences[0]!.pages[0]!.request.accountId = "999988887777";
  assert.throws(
    () => normalizeAwsBudgetsCapture(wrongAccount, SCOPE, NOW),
    (error) => error instanceof AwsBudgetsOrganizationError && error.code === "INVALID_PAGINATION",
  );
});

test("deduplicates byte-equivalent records and rejects conflicting budget identities", () => {
  const equivalent = capture();
  equivalent.budgetPages[0]!.response.records.push(
    structuredClone(equivalent.budgetPages[0]!.response.records[0]!),
  );
  assert.equal(normalizeAwsBudgetsCapture(equivalent, SCOPE, NOW).budgets.length, 1);

  const conflict = capture();
  const other = structuredClone(conflict.budgetPages[0]!.response.records[0]!);
  other.budgetLimit = { amount: "9999", unit: "USD" };
  conflict.budgetPages[0]!.response.records.push(other);
  assert.throws(
    () => normalizeAwsBudgetsCapture(conflict, SCOPE, NOW),
    (error) => error instanceof AwsBudgetsOrganizationError && error.code === "DUPLICATE_CONFLICT",
  );
});

test("rejects subscriber contacts, role ARNs, policies, and unmodeled provider fields", () => {
  const subscriberContact = capture() as unknown as Record<string, unknown>;
  const subscriberSequences = subscriberContact.subscriberSequences as Array<{
    pages: Array<{ response: { records: Array<Record<string, unknown>> } }>;
  }>;
  subscriberSequences[0]!.pages[0]!.response.records[0]!.address = "finops@example.test";
  assert.throws(
    () => normalizeAwsBudgetsCapture(subscriberContact, SCOPE, NOW),
    (error) => error instanceof AwsBudgetsOrganizationError && error.code === "INVALID_CAPTURE",
  );

  const roleArn = capture() as unknown as Record<string, unknown>;
  const actionSequences = roleArn.actionSequences as Array<{
    pages: Array<{ response: { records: Array<Record<string, unknown>> } }>;
  }>;
  actionSequences[0]!.pages[0]!.response.records[0]!.executionRoleArn =
    "arn:aws:iam::123456789012:role/budget-action";
  actionSequences[0]!.pages[0]!.response.records[0]!.policy = { statement: "raw" };
  assert.throws(
    () => normalizeAwsBudgetsCapture(roleArn, SCOPE, NOW),
    (error) => error instanceof AwsBudgetsOrganizationError && error.code === "INVALID_CAPTURE",
  );
});

test("enforces provider history retention bounds and rejects mixed units within one budget", () => {
  const excessiveHistory = capture();
  const template = excessiveHistory.historySequences[0]!.pages[0]!.response.records[0]!;
  excessiveHistory.historySequences[0]!.pages[0]!.response.records = Array.from(
    { length: 14 },
    (_, index) => ({
      ...structuredClone(template),
      timePeriod: {
        start: new Date(Date.UTC(2025, index, 1)).toISOString(),
        end: new Date(Date.UTC(2025, index + 1, 1)).toISOString(),
      },
    }),
  );
  excessiveHistory.operationCoverage.find((item) =>
    item.operation === "DescribeBudgetPerformanceHistory"
  )!.recordCount = 14;
  assert.throws(
    () => normalizeAwsBudgetsCapture(excessiveHistory, SCOPE, NOW),
    (error) => error instanceof AwsBudgetsOrganizationError && error.code === "BOUND_EXCEEDED",
  );

  const mixedUnits = capture();
  mixedUnits.budgetPages[0]!.response.records[0]!.calculatedSpend.forecastedSpend = {
    amount: "10100.50",
    unit: "EUR",
  };
  assert.throws(
    () => normalizeAwsBudgetsCapture(mixedUnits, SCOPE, NOW),
    (error) => error instanceof AwsBudgetsOrganizationError && error.code === "INVALID_CAPTURE",
  );
});

test("represents denied access as configuration-required with unknown totals, not zero", () => {
  const denied = capture();
  denied.operationCoverage = AWS_BUDGETS_READ_API_OPERATIONS.map((operation) => ({
    operation,
    state: "ACCESS_DENIED" as const,
    recordCount: 0,
    failureCode: "ACCESS_DENIED" as const,
  }));
  denied.budgetPages = [];
  denied.historySequences = [];
  denied.notificationSequences = [];
  denied.subscriberSequences = [];
  denied.actionSequences = [];
  const snapshot = normalizeAwsBudgetsCapture(denied, SCOPE, NOW);
  assert.equal(snapshot.collectionState, "configuration_required");
  const source = awsBudgetsOrganizationSourceEvidence(snapshot);
  assert.equal(source.configured, false);
  assert.equal(source.deliveryObserved, false);
  assert.equal(source.coverage.acceptedRecords, null);
  assert.equal(source.coverage.expectedRecords, null);
  const dashboard = buildAwsBudgetsOrganizationDashboard({
    snapshot,
    hierarchy: null,
    taxonomy: null,
    nowEpochMs: NOW,
  });
  assert.equal(dashboard.state, "configuration_required");
  assert.equal(dashboard.coverage.totalAwsBudgets, null);
  assert.equal(dashboard.coverage.matchedAwsBudgets, null);
});

test("marks missing forecast and missing hierarchy without inventing values or account coverage", () => {
  const missingForecast = capture();
  missingForecast.budgetPages[0]!.response.records[0]!.calculatedSpend.forecastedSpend = null;
  const snapshot = normalizeAwsBudgetsCapture(missingForecast, SCOPE, NOW);
  assert.equal(snapshot.collectionState, "partial");
  assert.equal(snapshot.budgets[0]?.forecast, null);
  assert.equal(snapshot.budgets[0]?.coverage.forecast, "unavailable");
  const dashboard = buildAwsBudgetsOrganizationDashboard({
    snapshot,
    hierarchy: null,
    taxonomy: taxonomy(),
    query: { accountIds: [LINKED_ACCOUNT_ID] },
    nowEpochMs: NOW,
  });
  assert.equal(dashboard.state, "configuration_required");
  assert.equal(dashboard.coverage.matchedAwsBudgets, null);
});

test("keeps currencies separate and enforces bounded exact filters and cursors", () => {
  const snapshot = normalizeAwsBudgetsCapture(capture(), SCOPE, NOW);
  const usd = buildAwsBudgetsOrganizationDashboard({
    snapshot,
    hierarchy: hierarchy(),
    taxonomy: taxonomy(),
    query: { currencies: ["USD"], budgetTypes: ["COST"], namePrefix: "Platform" },
    nowEpochMs: NOW,
  });
  assert.equal(usd.budgets.length, 1);
  const eur = buildAwsBudgetsOrganizationDashboard({
    snapshot,
    hierarchy: hierarchy(),
    taxonomy: taxonomy(),
    query: { currencies: ["EUR"] },
    nowEpochMs: NOW,
  });
  assert.equal(eur.budgets.length, 0);
  assert.throws(
    () => buildAwsBudgetsOrganizationDashboard({
      snapshot,
      hierarchy: hierarchy(),
      taxonomy: taxonomy(),
      query: { page: { cursor: "../../tenant" } },
      nowEpochMs: NOW,
    }),
    (error) => error instanceof AwsBudgetsOrganizationError && error.code === "INVALID_QUERY",
  );
});

test("documents exact read APIs, IAM actions, and organization dependencies without mutation", () => {
  assert.deepEqual(AWS_BUDGETS_READ_API_OPERATIONS, [
    "DescribeBudgets",
    "DescribeBudgetPerformanceHistory",
    "DescribeNotificationsForBudget",
    "DescribeSubscribersForNotification",
    "DescribeBudgetActionsForBudget",
  ]);
  assert.deepEqual(AWS_BUDGETS_READ_IAM_ACTIONS, [
    "aws-portal:ViewBilling",
    "budgets:ViewBudget",
    "budgets:DescribeBudgetActionsForBudget",
  ]);
  assert.deepEqual(AWS_BUDGETS_DEPENDENT_IAM_ACTIONS, ["billing:GetBillingViewData"]);
  assert.deepEqual(AWS_BUDGETS_ORGANIZATION_READ_IAM_ACTIONS, [
    "organizations:DescribeOrganization",
    "organizations:ListAccounts",
    "organizations:ListRoots",
    "organizations:ListOrganizationalUnitsForParent",
    "organizations:ListParents",
  ]);
  const all = [
    ...AWS_BUDGETS_READ_IAM_ACTIONS,
    ...AWS_BUDGETS_DEPENDENT_IAM_ACTIONS,
    ...AWS_BUDGETS_ORGANIZATION_READ_IAM_ACTIONS,
  ];
  assert.equal(all.some((action) => /(?:Create|Delete|Execute|Modify|Put|Tag|Untag|Update)/u.test(action)), false);
});
