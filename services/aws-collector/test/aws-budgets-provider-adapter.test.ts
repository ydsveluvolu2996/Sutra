import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { BudgetsClient } from "@aws-sdk/client-budgets";
import type { OrganizationsClient } from "@aws-sdk/client-organizations";
import {
  AWS_BUDGETS_PROVIDER_SESSION_ACTIONS,
  collectAwsBudgetsProviderEvidence,
  type AwsBudgetsProviderClients,
  type AwsBudgetsProviderScope,
} from "../src/aws-budgets-provider-adapter.js";
import {
  parseAwsBudgetsProviderRouteRequest,
  runAwsBudgetsProviderRoute,
} from "../src/aws-budgets-provider-route.js";
import { awsBudgetsProviderSessionPolicy } from "../src/role-broker.js";
import {
  createLocalCollectorServer,
  type CollectorConnectionRegistry,
} from "../src/local-server.js";
import type { ValidatedRoleSession } from "../src/types.js";

const NOW = Date.parse("2026-08-02T06:00:00.000Z");
const SCOPE: AwsBudgetsProviderScope = {
  orgId: "org_budgets_a",
  customerId: "customer_budgets_a",
  connectionId: `conn_${"a".repeat(32)}`,
  accountId: "111122223333",
  partition: "aws",
};

function budget() {
  return {
    BudgetName: "Engineering monthly",
    BudgetLimit: { Amount: "1250.125", Unit: "USD" },
    PlannedBudgetLimits: {},
    CostFilters: { LinkedAccount: [SCOPE.accountId] },
    CostTypes: {},
    TimeUnit: "MONTHLY",
    TimePeriod: {
      Start: new Date("2026-08-01T00:00:00.000Z"),
      End: new Date("2026-09-01T00:00:00.000Z"),
    },
    CalculatedSpend: {
      ActualSpend: { Amount: "420.25", Unit: "USD" },
      ForecastedSpend: { Amount: "1300.5", Unit: "USD" },
    },
    BudgetType: "COST",
    LastUpdatedTime: new Date("2026-08-02T05:00:00.000Z"),
    Metrics: ["UnblendedCost"],
  };
}

function clients(options: { readonly repeatedBudgetToken?: boolean } = {}): AwsBudgetsProviderClients {
  let budgetPage = 0;
  const budgets = {
    async send(command: { readonly constructor: { readonly name: string }; readonly input: Record<string, unknown> }) {
      switch (command.constructor.name) {
        case "DescribeBudgetsCommand": {
          budgetPage += 1;
          if (options.repeatedBudgetToken && budgetPage === 1) return { Budgets: [budget()], NextToken: "repeat" };
          if (options.repeatedBudgetToken) return { Budgets: [], NextToken: "repeat" };
          return { Budgets: [budget()] };
        }
        case "DescribeBudgetPerformanceHistoryCommand": return {
          BudgetPerformanceHistory: { BudgetedAndActualAmountsList: [{
            TimePeriod: { Start: new Date("2026-07-01T00:00:00.000Z"), End: new Date("2026-08-01T00:00:00.000Z") },
            BudgetedAmount: { Amount: "1200", Unit: "USD" },
            ActualAmount: { Amount: "1180.125", Unit: "USD" },
          }] },
        };
        case "DescribeNotificationsForBudgetCommand": return { Notifications: [{
          ComparisonOperator: "GREATER_THAN", NotificationType: "FORECASTED",
          Threshold: 100, ThresholdType: "PERCENTAGE",
        }] };
        case "DescribeSubscribersForNotificationCommand": return { Subscribers: [
          { SubscriptionType: "EMAIL", Address: "private@example.invalid" },
          { SubscriptionType: "SNS", Address: "arn:aws:sns:us-east-1:111122223333:private" },
        ] };
        case "DescribeBudgetActionsForBudgetCommand": return { Actions: [{
          ActionId: "action-1234", BudgetName: "Engineering monthly",
          NotificationType: "ACTUAL", ActionType: "APPLY_IAM_POLICY",
          ActionThreshold: { ActionThresholdValue: 100, ActionThresholdType: "PERCENTAGE" },
          Definition: { IamActionDefinition: { PolicyArn: "arn:aws:iam::aws:policy/ReadOnlyAccess", Roles: ["private-role"] } },
          ExecutionRoleArn: "arn:aws:iam::111122223333:role/private-execution-role",
          ApprovalModel: "MANUAL", Status: "STANDBY", Subscribers: [],
        }] };
        case "ListTagsForResourceCommand": return { ResourceTags: [
          { Key: "cid:budget-level", Value: "BusinessUnit" },
          { Key: "secret", Value: "must-not-cross" },
        ] };
        default: throw new Error(`unexpected budgets command ${command.constructor.name}`);
      }
    },
  } as unknown as BudgetsClient;
  const organizations = {
    async send(command: { readonly constructor: { readonly name: string } }) {
      switch (command.constructor.name) {
        case "DescribeOrganizationCommand": return { Organization: { Id: "o-abcdefghij" } };
        case "ListRootsCommand": return { Roots: [{ Id: "r-abcd" }] };
        case "ListOrganizationalUnitsForParentCommand": return { OrganizationalUnits: [] };
        case "ListAccountsCommand": return { Accounts: [{ Id: SCOPE.accountId, Name: "Engineering" }] };
        case "ListParentsCommand": return { Parents: [{ Id: "r-abcd", Type: "ROOT" }] };
        default: throw new Error(`unexpected organizations command ${command.constructor.name}`);
      }
    },
  } as unknown as OrganizationsClient;
  return { budgets, organizations };
}

function requestBody(scope: AwsBudgetsProviderScope = SCOPE): string {
  return JSON.stringify({
    schemaVersion: "sutra.aws-budgets-durable-request.v1",
    requestId: `abr_${"1".repeat(64)}`,
    jobId: `job_${"2".repeat(32)}`,
    scheduledWindow: "2026-08-02T06:00:00.000Z",
    scope,
    budgetOperations: [
      "DescribeBudgets", "DescribeBudgetPerformanceHistory", "DescribeNotificationsForBudget",
      "DescribeSubscribersForNotification", "DescribeBudgetActionsForBudget", "ListTagsForResource",
    ],
    organizationOperations: [
      "organizations:DescribeOrganization", "organizations:ListAccounts", "organizations:ListRoots",
      "organizations:ListOrganizationalUnitsForParent", "organizations:ListParents",
    ],
    hierarchyTagKey: "cid:budget-level",
    bounds: {
      apiPageSize: 100, maximumPages: 5_000, maximumBudgets: 1_000,
      maximumHistoryRecords: 20_000, maximumDailyHistoryPerBudget: 60,
      maximumMonthlyHistoryPerBudget: 13, maximumQuarterlyHistoryPerBudget: 4,
      maximumNotifications: 5_000, maximumSubscribers: 50_000, maximumActions: 10_000,
      maximumBudgetLevelTags: 1_000, maximumCostFilterKeys: 50,
      maximumCostFilterValuesPerKey: 100, maximumTextCharacters: 256,
      maximumCaptureBytes: 12 * 1_024 * 1_024, maximumDashboardBytes: 4 * 1_024 * 1_024,
      maximumQueryPageSize: 100, maximumQueryAccountFilters: 100,
      maximumHierarchyAccounts: 10_000, maximumTaxonomyAssignments: 10_000,
      sourceFreshnessSlaHours: 24,
    },
    maximumDurationMs: 300_000,
  });
}

test("provider adapter collects complete minimized budgets and hierarchy evidence", async () => {
  let clock = NOW;
  const result = await collectAwsBudgetsProviderEvidence({
    scope: SCOPE,
    clients: clients(),
    signal: new AbortController().signal,
    now: () => clock++,
  });
  assert.match(result.capture.captureId, /^awsbudgets_[a-f0-9]{64}$/u);
  assert.equal(result.capture.operationCoverage.every((item) => item.state === "SUCCEEDED"), true);
  assert.equal(result.hierarchy.state, "complete");
  assert.equal(result.hierarchy.accounts[0]?.accountName, "Engineering");
  const serialized = JSON.stringify(result);
  for (const secret of ["private@example.invalid", "private-execution-role", "private-role", "must-not-cross"]) {
    assert.equal(serialized.includes(secret), false, `${secret} must be minimized at the broker boundary`);
  }
  assert.match(serialized, /BusinessUnit/u);
  assert.match(serialized, /"amount":"1250\.125"/u);
});

test("repeated provider pagination is retained as bounded PARTIAL evidence without a token cycle", async () => {
  let clock = NOW;
  const result = await collectAwsBudgetsProviderEvidence({
    scope: SCOPE, clients: clients({ repeatedBudgetToken: true }), now: () => clock++,
  });
  const enumeration = result.capture.operationCoverage.find((item) => item.operation === "DescribeBudgets");
  assert.equal(enumeration?.state, "PARTIAL");
  assert.equal(enumeration?.failureCode, "UNKNOWN");
  assert.equal(result.capture.budgetPages.length, 1);
  assert.equal(result.capture.budgetPages[0]?.response.nextToken, "repeat");
});

test("route pins signed body, headers, tenant scope and exact session action ceiling", async () => {
  const body = requestBody();
  assert.equal(parseAwsBudgetsProviderRouteRequest(body).scope.accountId, SCOPE.accountId);
  let assumed = 0;
  let clock = NOW;
  const response = await runAwsBudgetsProviderRoute({
    body,
    headers: { tenantId: SCOPE.orgId, customerId: SCOPE.customerId, connectionId: SCOPE.connectionId, jobId: `job_${"2".repeat(32)}` },
    signal: new AbortController().signal,
  }, {
    assumeReadOnlySession: async (input) => {
      assumed += 1;
      assert.deepEqual(input.sessionActions, AWS_BUDGETS_PROVIDER_SESSION_ACTIONS);
      assert.equal(input.expectedAccountId, SCOPE.accountId);
      return {
        accountId: SCOPE.accountId, partition: "aws",
        credentials: { accessKeyId: "server", secretAccessKey: "server", sessionToken: "server", expiration: new Date(NOW + 60_000) },
      };
    },
    clientFactory: () => clients(),
    now: () => clock++,
  });
  assert.equal(assumed, 1);
  assert.equal(response.requestId, `abr_${"1".repeat(64)}`);
  assert.match(response.requestBodySha256, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(response).includes("server"), false);

  await assert.rejects(runAwsBudgetsProviderRoute({
    body,
    headers: { tenantId: "org_foreign", customerId: SCOPE.customerId, connectionId: SCOPE.connectionId, jobId: `job_${"2".repeat(32)}` },
    signal: new AbortController().signal,
  }, {
    assumeReadOnlySession: async () => { throw new Error("must not be called"); },
  }), (error) => error instanceof Error && error.name === "AwsBudgetsProviderAdapterError" && !error.message.includes("org_foreign"));
  assert.equal(assumed, 1);
});

test("role broker emits an exact read-only AWS Budgets session intersection", () => {
  const policy = JSON.parse(awsBudgetsProviderSessionPolicy()) as {
    readonly Version: string;
    readonly Statement: readonly [{
      readonly Effect: string;
      readonly Action: readonly string[];
      readonly Resource: string;
    }];
  };
  assert.equal(policy.Version, "2012-10-17");
  assert.equal(policy.Statement.length, 1);
  assert.equal(policy.Statement[0].Effect, "Allow");
  assert.equal(policy.Statement[0].Resource, "*");
  assert.deepEqual(policy.Statement[0].Action, AWS_BUDGETS_PROVIDER_SESSION_ACTIONS);
  assert.equal(policy.Statement[0].Action.some((action) => /create|delete|modify|update/iu.test(action)), false);
});

test("local collector serves the exact authenticated provider route and rejects header substitution", async () => {
  let assumed = 0;
  let clock = NOW;
  const server = createLocalCollectorServer({
    mode: "live",
    allowLiveAws: true,
    hostedRuntime: true,
    principalArn: "arn:aws:iam::999900001111:role/SutraHostedBroker",
    now: () => new Date(clock++),
    registry: {} as CollectorConnectionRegistry,
    authenticator: {
      verify: async () => ({ nonce: "test-nonce", timestamp: NOW }),
      responseSignature: async () => "test-signature",
    },
    awsBudgetsProviderClientFactory: () => clients(),
    awsBudgetsProviderRoleBrokerFactory: () => ({
      assumeValidatedAwsBudgetsSession: async (scope, connectionId, jobId, input) => {
        assumed += 1;
        assert.equal(scope.tenantId, SCOPE.orgId);
        assert.equal(connectionId, SCOPE.connectionId);
        assert.equal(jobId, `job_${"2".repeat(32)}`);
        assert.deepEqual(input.sessionActions, AWS_BUDGETS_PROVIDER_SESSION_ACTIONS);
        return {
          connectionId,
          accountId: SCOPE.accountId,
          partition: "aws",
          roleArn: `arn:aws:iam::${SCOPE.accountId}:role/SutraCollectorRole`,
          roleSessionName: "sutra-budgets-test",
          callerIdentityArn: `arn:aws:sts::${SCOPE.accountId}:assumed-role/SutraCollectorRole/sutra-budgets-test`,
          expiresAt: new Date(NOW + 60_000),
          credentials: {
            accessKeyId: "server-access-key",
            secretAccessKey: "server-secret-key",
            sessionToken: "server-session-token",
            expiration: new Date(NOW + 60_000),
          },
        } satisfies ValidatedRoleSession;
      },
    }),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (tenantId: string) => fetch(`${base}/v1/finops/aws-budgets/collect`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sutra-tenant-id": tenantId,
      "x-sutra-customer-id": SCOPE.customerId,
      "x-sutra-connection-id": SCOPE.connectionId,
      "x-sutra-job-id": `job_${"2".repeat(32)}`,
    },
    body: requestBody(),
  });
  try {
    const accepted = await post(SCOPE.orgId);
    assert.equal(accepted.status, 200);
    const value = await accepted.json() as Record<string, unknown>;
    assert.equal(value.requestId, `abr_${"1".repeat(64)}`);
    assert.equal(JSON.stringify(value).includes("server-secret-key"), false);
    assert.equal(assumed, 1);

    const substituted = await post("org_foreign");
    assert.equal(substituted.status, 400);
    assert.deepEqual(await substituted.json(), {
      code: "INVALID_REQUEST",
      message: "The bounded AWS Budgets provider collection did not complete",
    });
    assert.equal(assumed, 1, "header substitution must fail before role assumption");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("route rejects widened operations, altered bounds, scope substitution and extra fields", () => {
  for (const mutate of [
    (value: Record<string, unknown>) => { (value.budgetOperations as string[]).push("UpdateBudget"); },
    (value: Record<string, unknown>) => { (value.bounds as Record<string, unknown>).maximumBudgets = 10_001; },
    (value: Record<string, unknown>) => { (value.scope as Record<string, unknown>).accountId = "999900001111"; },
    (value: Record<string, unknown>) => { value.credentials = "attacker"; },
  ]) {
    const parsed = JSON.parse(requestBody()) as Record<string, unknown>;
    mutate(parsed);
    const body = JSON.stringify(parsed);
    if ((parsed.scope as Record<string, unknown>).accountId === "999900001111") {
      assert.equal(parseAwsBudgetsProviderRouteRequest(body).scope.accountId, "999900001111");
    } else {
      assert.throws(() => parseAwsBudgetsProviderRouteRequest(body), /did not complete/u);
    }
  }
});
