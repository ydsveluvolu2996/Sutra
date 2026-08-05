import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  root: process.cwd(), configFile: false, logLevel: "silent", server: { middlewareMode: true },
});
const adapter = await vite.ssrLoadModule("/services/aws-collector/src/aws-budgets-provider-adapter.ts");
const engine = await vite.ssrLoadModule("/lib/finops-aws-budgets-organization.ts");
test.after(async () => vite.close());

const NOW = Date.parse("2026-08-02T06:00:00.000Z");
const SCOPE = {
  orgId: "org_adv08_contract", customerId: "customer_adv08_contract",
  connectionId: `conn_${"8".repeat(32)}`, accountId: "111122223333", partition: "aws",
};

function clients() {
  return {
    budgets: { send: async (command) => {
      switch (command.constructor.name) {
        case "DescribeBudgetsCommand": return { Budgets: [{
          BudgetName: "Contract budget", BudgetLimit: { Amount: "100.125", Unit: "USD" },
          CostFilters: { LinkedAccount: [SCOPE.accountId] }, CostTypes: {}, TimeUnit: "MONTHLY",
          TimePeriod: { Start: new Date("2026-08-01T00:00:00.000Z"), End: new Date("2026-09-01T00:00:00.000Z") },
          CalculatedSpend: { ActualSpend: { Amount: "60.25", Unit: "USD" }, ForecastedSpend: { Amount: "110.5", Unit: "USD" } },
          BudgetType: "COST", LastUpdatedTime: new Date("2026-08-02T05:00:00.000Z"), Metrics: ["UnblendedCost"],
        }] };
        case "DescribeBudgetPerformanceHistoryCommand": return { BudgetPerformanceHistory: { BudgetedAndActualAmountsList: [{
          TimePeriod: { Start: new Date("2026-07-01T00:00:00.000Z"), End: new Date("2026-08-01T00:00:00.000Z") },
          BudgetedAmount: { Amount: "90", Unit: "USD" }, ActualAmount: { Amount: "80", Unit: "USD" },
        }] } };
        case "DescribeNotificationsForBudgetCommand": return { Notifications: [] };
        case "DescribeBudgetActionsForBudgetCommand": return { Actions: [] };
        case "ListTagsForResourceCommand": return { ResourceTags: [{ Key: "cid:budget-level", Value: "BusinessUnit" }] };
        default: throw new Error(`unexpected budgets operation ${command.constructor.name}`);
      }
    } },
    organizations: { send: async (command) => {
      switch (command.constructor.name) {
        case "DescribeOrganizationCommand": return { Organization: { Id: "o-abcdefghij" } };
        case "ListRootsCommand": return { Roots: [{ Id: "r-root" }] };
        case "ListOrganizationalUnitsForParentCommand": return { OrganizationalUnits: [] };
        case "ListAccountsCommand": return { Accounts: [{ Id: SCOPE.accountId, Name: "Management" }] };
        case "ListParentsCommand": return { Parents: [{ Id: "r-root", Type: "ROOT" }] };
        default: throw new Error(`unexpected organizations operation ${command.constructor.name}`);
      }
    } },
  };
}

test("collector output is accepted unchanged by the immutable engine and native dashboard", async () => {
  let now = NOW;
  const evidence = await adapter.collectAwsBudgetsProviderEvidence({
    scope: SCOPE, clients: clients(), now: () => now++,
  });
  const snapshot = engine.normalizeAwsBudgetsCapture(evidence.capture, SCOPE, NOW + 10_000);
  assert.equal(snapshot.collectionState, "ready");
  assert.equal(snapshot.budgets[0].budgetLimit.amountMicros, "100125000");
  assert.equal(snapshot.budgets[0].actual.amountMicros, "60250000");
  assert.equal(snapshot.budgets[0].forecast.amountMicros, "110500000");
  const dashboard = engine.buildAwsBudgetsOrganizationDashboard({
    snapshot, hierarchy: evidence.hierarchy, taxonomy: null, nowEpochMs: NOW + 10_000,
  });
  assert.equal(dashboard.state, "partial", "missing optional Sutra taxonomy must stay visible");
  assert.deepEqual(dashboard.budgets[0].health.statuses, ["HEALTHY", "FORECASTED_UNHEALTHY"]);
  assert.equal(dashboard.budgets[0].accountMappings[0].accountName, "Management");
  assert.equal(dashboard.coverage.budgetLevels[0], "BusinessUnit");
});
