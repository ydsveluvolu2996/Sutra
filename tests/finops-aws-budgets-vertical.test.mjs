import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { Miniflare } from "miniflare";
import { createServer } from "vite";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const root = path.resolve(import.meta.dirname, "..");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { AwsBudgetsOrganizationRepository, AwsBudgetsRepositoryError } =
  await import("../db/finops-aws-budgets-organization-repository.ts");
const { runAwsBudgetsCollectionJob, AwsBudgetsCollectorJobError } =
  await import("../lib/finops-aws-budgets-collector-job.ts");

const ORG_A = "org_aws_budgets_a";
const ORG_B = "org_aws_budgets_b";
const CUSTOMER_A = "customer_aws_budgets_a";
const CUSTOMER_B = "customer_aws_budgets_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const ACCOUNT_A = "111122223333";
const ACCOUNT_B = "999900001111";
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A, accountId: ACCOUNT_A, partition: "aws" };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B, connectionId: CONNECTION_B, accountId: ACCOUNT_B, partition: "aws" };

function capture(character = "a", completedAtIso = "2026-08-01T01:00:00.000Z", partial = false) {
  const operations = ["DescribeBudgets", "DescribeBudgetPerformanceHistory", "DescribeNotificationsForBudget", "DescribeSubscribersForNotification", "DescribeBudgetActionsForBudget", "ListTagsForResource"];
  return {
    schemaVersion: "sutra.aws-budgets-organization.v1",
    scope: { ...SCOPE_A },
    captureId: `awsbudgets_${character.repeat(64)}`,
    startedAtIso: new Date(Date.parse(completedAtIso) - 60_000).toISOString(),
    completedAtIso,
    operationCoverage: operations.map((operation) => operation === "ListTagsForResource" && partial
      ? { operation, state: "PARTIAL", recordCount: 0, failureCode: "BOUND_REACHED" }
      : { operation, state: "SUCCEEDED", recordCount: 0, failureCode: null }),
    budgetPages: [{ request: { accountId: ACCOUNT_A, maxResults: 100, nextToken: null }, response: { records: [], nextToken: null } }],
    historySequences: [], notificationSequences: [], subscriberSequences: [], actionSequences: [], tagSequences: [],
  };
}

function hierarchy(observedAtIso = "2026-08-01T00:55:00.000Z") {
  return {
    scope: { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A },
    sourceEvidenceId: `aws_org_${observedAtIso.slice(0, 10).replaceAll("-", "")}`,
    observedAtIso,
    state: "complete",
    accounts: [{ accountId: ACCOUNT_A, accountName: "Management", parentId: "r-root", ouPath: ["Root"] }],
  };
}

function connection(database, id, org, customer, account) {
  return database.prepare(`INSERT INTO aws_connections (
    id, org_id, customer_id, source_kind, partition, aws_account_id, role_arn,
    external_id_ciphertext, external_id_key_version, permission_pack_version,
    status, enabled_regions_json
  ) VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, 'ct', 'v1',
    'standard-2026-08.1', 'active', '[]')`).bind(
      id, org, customer, account, `arn:aws:iam::${account}:role/sutra/SutraCollectorRole`,
    );
}

async function applyVerticalMigration(database) {
  const exists = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'finops_aws_budget_snapshots'").first();
  if (exists !== null) return;
  const sql = await readFile(path.join(root, "drizzle/0091_finops_aws_budgets_organization.sql"), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
  }
}

async function withRepository(run) {
  const miniflare = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", compatibilityDate: "2026-05-22", d1Databases: { DB: `sutra-aws-budgets-${crypto.randomUUID()}` }, d1Persist: false });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await applyVerticalMigration(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'aba', 'AWS Budgets A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'abb', 'AWS Budgets B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'abca', 'AWS Budgets CA', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'abcb', 'AWS Budgets CB', 'active')").bind(CUSTOMER_B, ORG_B),
      connection(database, CONNECTION_A, ORG_A, CUSTOMER_A, ACCOUNT_A),
      connection(database, CONNECTION_B, ORG_B, CUSTOMER_B, ACCOUNT_B),
    ]);
    await run({ database, repository: new AwsBudgetsOrganizationRepository(database) });
  } finally { await miniflare.dispose(); }
}

test("provider AWS Budgets generations are immutable, tenant-bound, replay-safe and monotonic", async () => {
  await withRepository(async ({ database, repository }) => {
    const first = await repository.recordCapture(SCOPE_A, capture("a"), hierarchy(), Date.parse("2026-08-01T01:01:00.000Z"));
    assert.equal(first.becameActive, true);
    assert.equal(first.generation.snapshot.budgets.length, 0);
    const replay = await repository.recordCapture(SCOPE_A, capture("a"), hierarchy(), Date.parse("2026-08-01T01:02:00.000Z"));
    assert.equal(replay.becameActive, false);
    assert.equal((await repository.getActiveGeneration(SCOPE_A))?.generationId, first.generation.generationId);
    assert.equal(await repository.getActiveGeneration(SCOPE_B), null);

    const partial = await repository.recordCapture(SCOPE_A, capture("b", "2026-08-01T02:00:00.000Z", true), hierarchy("2026-08-01T01:55:00.000Z"), Date.parse("2026-08-01T02:01:00.000Z"));
    assert.equal(partial.generation.snapshot.collectionState, "partial");
    assert.equal((await repository.getLatestGeneration(SCOPE_A))?.generationId, partial.generation.generationId);
    assert.equal((await repository.getActiveGeneration(SCOPE_A))?.generationId, first.generation.generationId);
    await assert.rejects(database.prepare("UPDATE finops_aws_budget_snapshots SET state = 'partial' WHERE generation_id = ?").bind(first.generation.generationId).run(), /FINOPS_AWS_BUDGET_SNAPSHOT_IMMUTABLE/u);
  });
});

test("provider capture conflicts and connection identity substitutions fail closed", async () => {
  await withRepository(async ({ repository }) => {
    await repository.recordCapture(SCOPE_A, capture("c"), hierarchy(), Date.parse("2026-08-01T01:01:00.000Z"));
    const changedHierarchy = { ...hierarchy(), sourceEvidenceId: "aws_org_conflict" };
    await assert.rejects(
      repository.recordCapture(SCOPE_A, capture("c"), changedHierarchy, Date.parse("2026-08-01T01:02:00.000Z")),
      (error) => error instanceof AwsBudgetsRepositoryError && error.code === "IMMUTABLE_CONFLICT",
    );
    await assert.rejects(
      repository.getActiveGeneration({ ...SCOPE_A, accountId: ACCOUNT_B }),
      (error) => error instanceof AwsBudgetsRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
  });
});

test("collection job pins read-only operations, provider hierarchy tag and exact tenant scope", async () => {
  let request;
  const result = await runAwsBudgetsCollectionJob({
    scope: SCOPE_A, nowMs: Date.parse("2026-08-01T01:01:00.000Z"),
    broker: { collect: async (value) => { request = value; return { capture: capture("d"), hierarchy: hierarchy() }; } },
    store: { recordCapture: async (scope, providerCapture) => {
      assert.deepEqual(scope, SCOPE_A);
      return { generation: { generationId: `abg_${"e".repeat(64)}`, snapshot: { captureId: providerCapture.captureId, collectionState: "ready" } }, becameActive: true };
    } },
  });
  assert.equal(request.budgetHierarchyTagKey, "cid:budget-level");
  assert.deepEqual(request.budgetOperations, ["DescribeBudgets", "DescribeBudgetPerformanceHistory", "DescribeNotificationsForBudget", "DescribeSubscribersForNotification", "DescribeBudgetActionsForBudget", "ListTagsForResource"]);
  assert.ok(request.organizationOperations.includes("organizations:ListAccounts"));
  assert.equal(result.becameActive, true);

  await assert.rejects(runAwsBudgetsCollectionJob({
    scope: SCOPE_A,
    broker: { collect: async () => ({ capture: { ...capture("f"), scope: { ...SCOPE_A, orgId: ORG_B } }, hierarchy: null }) },
    store: { recordCapture: async () => { throw new Error("must not persist"); } },
  }), (error) => error instanceof AwsBudgetsCollectorJobError && !/must not persist/u.test(error.message));
});

test("API and migrations enforce provider/internal separation, same-tenant reads and complete-only heads", async () => {
  const [route, repository, sqlite, postgres] = await Promise.all([
    readFile(path.join(root, "app/api/v1/finops/aws-budgets-organization/route.ts"), "utf8"),
    readFile(path.join(root, "db/finops-aws-budgets-organization-repository.ts"), "utf8"),
    readFile(path.join(root, "drizzle/0091_finops_aws_budgets_organization.sql"), "utf8"),
    readFile(path.join(root, "postgres/migrations/0086_finops_aws_budgets_organization.sql"), "utf8"),
  ]);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(route, /sutraInternalBudgetsIncluded: false/u);
  assert.match(route, /cid:budget-level/u);
  assert.match(route, /AWS_BUDGETS_SIGNED_BROKER_HANDLER_NOT_REGISTERED/u);
  assert.doesNotMatch(route, /createBudget|updateBudget|deleteBudget|FinopsWorkspaceRepository/u);
  assert.match(repository, /deliberately unrelated to finops_budgets/u);
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /FINOPS_AWS_BUDGET_SNAPSHOT_IMMUTABLE/u);
    assert.match(sql, /candidate\.?`?state`?.*ready/u);
    assert.match(sql, /candidate\.?`?hierarchy_state`?.*complete/u);
    assert.match(sql, /candidate\.?`?observed_at`? > active\.?`?observed_at`?/u);
  }
});

test("native report renders hierarchy, budgeted/actual/forecast, honest status, history and evidence", async () => {
  const vite = await createServer({ root, configFile: false, logLevel: "silent", plugins: [react()], server: { middlewareMode: true } });
  try {
    const dashboardModule = await vite.ssrLoadModule("/app/costs/finops-aws-budgets-organization-dashboard.tsx");
    const budget = {
      source: "AWS_BUDGETS", accountId: ACCOUNT_A, budgetName: "Platform budget", budgetType: "COST", timeUnit: "MONTHLY",
      effectivePeriod: { start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" },
      budgetLimit: { amount: "100", amountMicros: "100000000", unit: "USD", currency: "USD" }, plannedBudgetLimits: [],
      actual: { amount: "62.5", amountMicros: "62500000", unit: "USD", currency: "USD" },
      forecast: { amount: "101", amountMicros: "101000000", unit: "USD", currency: "USD" },
      costFilters: [{ key: "LinkedAccount", values: [ACCOUNT_A] }], costTypes: {}, metrics: ["UnblendedCost"], lastUpdatedAt: "2026-08-01T00:00:00.000Z",
      history: [{ periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-08-01T00:00:00.000Z", budgeted: { amount: "90", amountMicros: "90000000", unit: "USD", currency: "USD" }, actual: { amount: "80", amountMicros: "80000000", unit: "USD", currency: "USD" }, forecast: null }],
      notifications: [], actions: [], hierarchyLevel: "BusinessUnit", coverage: { history: "complete", notifications: "complete", subscribers: "complete", actions: "complete", hierarchyTag: "complete", actual: "available", forecast: "available" },
    };
    const dashboard = {
      schemaVersion: "sutra.aws-budgets-dashboard.v1", source: "AWS_BUDGETS", state: "ready",
      sourceEvidence: { captureId: `awsbudgets_${"a".repeat(64)}`, observedAtIso: "2026-08-01T01:00:00.000Z", dataThroughAt: "2026-08-01T00:00:00.000Z", freshness: { status: "fresh", ageSeconds: 3600, staleAfterSeconds: 86400 }, taxonomyEvidenceId: "tax-1", hierarchyEvidenceId: "org-1" },
      coverage: { totalAwsBudgets: 1, matchedAwsBudgets: 1, budgetsWithActual: 1, budgetsWithForecast: 1, organizationWideBudgets: 0, linkedAccountBudgets: 1, unresolvedBudgets: 0, mappedAccounts: 1, missingHierarchyAccounts: 0, missingTaxonomyAccounts: 0, currencies: ["USD"], budgetLevels: ["BusinessUnit"], healthStatusCounts: { HEALTHY: 1, UNHEALTHY: 0, FORECASTED_UNHEALTHY: 1, UNCLASSIFIED: 0 } },
      budgets: [{ budget, targeting: "linked_accounts", accountMappings: [{ accountId: ACCOUNT_A, accountName: "Platform", parentId: "ou-platform", ouPath: ["Root", "Platform"], company: "Sutra", businessUnit: "Platform", environment: "production", costCenter: "CC-1", owner: "finops", coverage: "complete" }], unmappedAccountIds: [], mappingCoverage: "complete", health: { statuses: ["HEALTHY", "FORECASTED_UNHEALTHY"], actualComparisonAvailable: true, forecastComparisonAvailable: true } }], nextCursor: null,
      internalSutraBudgets: { source: "SUTRA_INTERNAL_BUDGETS", included: false, reason: "Separate evidence." }, limitations: ["Provider evidence."],
    };
    const report = {
      schema: "sutra.finops-aws-budgets-dashboard.v1", connectionId: CONNECTION_A, source: "AWS_BUDGETS_PROVIDER", sourceState: "partial",
      freshness: { dataThroughAt: "2026-08-01T00:00:00.000Z", status: "fresh", ageHours: 1, staleAfterHours: 24 }, dashboard,
      history: [{ generationId: `abg_${"b".repeat(64)}`, sourceCaptureId: `awsbudgets_${"a".repeat(64)}`, state: "ready", hierarchyState: "complete", observedAtIso: "2026-08-01T01:00:00.000Z", dataThroughAtIso: "2026-08-01T00:00:00.000Z", budgetCount: 1, currencies: ["USD"], budgetLevels: ["BusinessUnit"] }],
      evidence: { generationId: `abg_${"b".repeat(64)}` }, separation: { providerSource: "AWS_BUDGETS", sutraInternalBudgetsIncluded: false, reason: "Separate evidence." }, collection: { jobContractAvailable: true, providerAdapterAvailable: false, reason: "AWS_BUDGETS_SIGNED_BROKER_HANDLER_NOT_REGISTERED" }, prerequisites: ["AWS Budgets", "AWS Organizations", "cid:budget-level"],
    };
    const html = renderToStaticMarkup(createElement(dashboardModule.FinopsAwsBudgetsOrganizationReportView, { report, filters: { currency: "", budgetType: "", accountId: "", budgetLevel: "", budgetStatus: "", namePrefix: "" }, onFiltersChange: () => undefined }));
    for (const text of ["never includes or merges Sutra-authored", "cid:budget-level", "Budget status", "Healthy budgets", "Unhealthy budgets", "Forecasted unhealthy budgets", "Unclassified evidence", "Budgeted", "Actual spend", "Forecasted spend", "Platform budget", "Provider status", "Budget performance history", "Collection evidence history", "AWS_BUDGETS_SIGNED_BROKER_HANDLER_NOT_REGISTERED", "Coverage is partial"]) assert.match(html, new RegExp(text, "iu"));
    assert.doesNotMatch(html, /fixture|sample|placeholder/iu);
  } finally { await vite.close(); }
});
