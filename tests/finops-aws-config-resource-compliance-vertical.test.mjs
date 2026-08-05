import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const [route, repository, sqlite, postgres, component, css, official] =
  await Promise.all([
    readFile(
      path.join(
        root,
        "app/api/v1/finops/aws-config-resource-compliance/route.ts",
      ),
      "utf8",
    ),
    readFile(
      path.join(root, "db/finops-aws-config-compliance-repository.ts"),
      "utf8",
    ),
    readFile(
      path.join(root, "drizzle/0087_finops_aws_config_compliance.sql"),
      "utf8",
    ),
    readFile(
      path.join(
        root,
        "postgres/migrations/0082_finops_aws_config_compliance.sql",
      ),
      "utf8",
    ),
    readFile(
      path.join(
        root,
        "app/costs/finops-aws-config-resource-compliance-dashboard.tsx",
      ),
      "utf8",
    ),
    readFile(
      path.join(
        root,
        "app/costs/finops-aws-config-resource-compliance-dashboard.module.css",
      ),
      "utf8",
    ),
    readFile(
      path.join(
        root,
        "lib/finops-aws-config-compliance-official-definition.ts",
      ),
      "utf8",
    ),
  ]);

test("Config compliance persistence is immutable and advances only complete monotonic heads", () => {
  for (const migration of [sqlite, postgres]) {
    assert.match(migration, /finops_config_compliance_snapshots/u);
    assert.match(migration, /finops_config_compliance_heads/u);
    assert.match(migration, /'READY','EMPTY'/u);
    assert.match(migration, /IMMUTABLE/u);
    assert.match(migration, /captured_at > current/u);
  }
  assert.match(
    repository,
    /COMPLETE_STATES = new Set<AwsConfigComplianceState>\(\["READY", "EMPTY"\]\)/u,
  );
  assert.match(repository, /snapshot\.scope\.orgId !== scope\.organizationId/u);
  assert.match(
    repository,
    /WHERE h\.org_id = \? AND h\.customer_id = \? AND h\.connection_id = \?/u,
  );
  assert.match(repository, /digest !== row\.content_sha256/u);
  assert.match(repository, /MAX_HISTORY = 36/u);
});

test("Config compliance API is authenticated, same-tenant, bounded, and exposes durable runtime state", () => {
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(
    route,
    /getConnectionForOrg\(\s*authenticated\.subject\.orgId,\s*query\.connectionId,?\s*\)/u,
  );
  assert.match(
    route,
    /assertSessionCapability\(\s*authenticated,\s*"connection:read",\s*connection\.customerId,?\s*\)/u,
  );
  assert.match(route, /RESULT_BOUND = 500/u);
  assert.match(route, /parameters|getAll\(key\)\.length > 1/u);
  assert.match(route, /AwsConfigComplianceRuntimeRepository/u);
  assert.match(route, /runtime\.getRuntimeStatus\(scope\)/u);
  assert.match(route, /activation:\s*\{ available: true/u);
  assert.equal(
    (
      route.match(
        /officialDefinition: AWS_CONFIG_COMPLIANCE_OFFICIAL_DEFINITION/gu,
      ) ?? []
    ).length,
    2,
  );
  assert.doesNotMatch(
    route,
    /StartConfigurationRecorder|PutConfigRule|DeleteConfigRule|StartResourceEvaluation/u,
  );
});

test("Config compliance UI has all honest states, drilldowns, evidence planes, and responsive focus", () => {
  for (const state of [
    "loading",
    "configuration_required",
    "collecting",
    "partial",
    "stale",
    "failed",
    "empty",
    "complete",
  ]) {
    assert.match(component, new RegExp(`view: (state|"${state}")`, "u"), state);
  }
  for (const label of [
    "AWS Config compliance filters",
    "Compliance trend",
    "Independent channel status",
    "Rule lifecycle",
    "Resource drilldown",
    "Configuration activity",
    "Actual AWS Config cost",
    "Generation evidence",
  ]) {
    assert.match(component, new RegExp(label, "u"), label);
  }
  assert.match(component, /credentials: "same-origin"/u);
  assert.match(component, /Provider-reported evaluation evidence/u);
  assert.match(component, /Activity counts are not invoice amounts/u);
  assert.match(component, /hasPinnedOfficialDefinition/u);
  assert.match(component, /Official source coverage remains available/u);
  assert.match(
    component,
    /does not claim QuickSight geometry or pixel parity/u,
  );
  assert.match(official, /completeDefinitionPublished: true/u);
  assert.match(official, /dashboardSpecificArtifactCount: 0/u);
  assert.match(official, /visuals: 124/u);
  assert.match(css, /\.filters select:focus-visible/u);
  assert.match(css, /\.officialSheets summary:focus-visible/u);
  assert.match(css, /min-height: 44px/u);
  assert.match(css, /@media screen and \(max-width: 760px\)/u);
});

test("Config compliance report renders provider evidence without fixtures or compliance inference", async () => {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    server: { middlewareMode: true },
  });
  try {
    const dashboardModule = await vite.ssrLoadModule(
      "/app/costs/finops-aws-config-resource-compliance-dashboard.tsx",
    );
    const definitionModule = await vite.ssrLoadModule(
      "/lib/finops-aws-config-compliance-official-definition.ts",
    );
    const report = {
      schema: "sutra.finops-aws-config-resource-compliance.v1",
      connectionId: `conn_${"a".repeat(32)}`,
      source: "AWS_CONFIG_ORGANIZATION_AGGREGATOR",
      sourceState: "complete",
      officialDefinition:
        definitionModule.AWS_CONFIG_COMPLIANCE_OFFICIAL_DEFINITION,
      freshness: {
        capturedAt: "2026-08-01T00:00:00.000Z",
        ageHours: 1,
        staleAfterHours: 48,
      },
      coverage: {
        status: "COMPLETE",
        expectedAccountCount: 1,
        expectedRegionCount: 1,
        expectedAccountRegionCount: 1,
        synchronizedAccountRegionCount: 1,
        recordingAccountRegionCount: 1,
        ruleInventoryAccountRegionCount: 1,
        missingAccountRegions: [],
      },
      channelStates: {
        aggregatorCompliance: "READY",
        ruleLifecycle: "READY",
        configurationActivity: "READY",
        actualCost: "READY",
      },
      counts: {
        rules: 1,
        compliantRules: 0,
        nonCompliantRules: 1,
        rulesWithoutResults: 0,
        rulesWithEvaluationErrors: 0,
        duplicateRuleDeployments: 0,
        currentEvaluations: 1,
        nonCompliantResources: 1,
        conformancePacks: 1,
        insufficientDataPacks: 0,
        discoveredResources: "9",
      },
      rules: [
        {
          accountId: "111122223333",
          region: "us-east-1",
          ruleName: "encrypted-volumes",
          complianceType: "NON_COMPLIANT",
          lifecycle: "ACTIVE",
          contributorCount: 1,
          contributorCountCapped: false,
          resourceTypes: ["AWS::EC2::Volume"],
          duplicateSignatureCount: 1,
        },
      ],
      evaluations: [
        {
          accountId: "111122223333",
          region: "us-east-1",
          ruleName: "encrypted-volumes",
          resourceType: "AWS::EC2::Volume",
          resourceId: "vol-rendered",
          complianceType: "NON_COMPLIANT",
          recordedAt: "2026-08-01T00:00:00.000Z",
          annotationPresent: false,
        },
      ],
      conformancePacks: [],
      resourceCounts: [],
      inventory: [
        {
          accountId: "111122223333",
          region: "us-east-1",
          resourceType: "AWS::EC2::Volume",
          resourceId: "vol-rendered",
          captureTime: "2026-08-01T00:00:00.000Z",
          itemStatus: "ResourceDiscovered",
        },
      ],
      activity: {
        configurationItemChanges: "9007199254740993",
        ruleEvaluations: "9007199254740995",
      },
      actualCosts: [
        {
          currency: "USD",
          billedCostMicros: "1234567",
          amortizedCostMicros: "1234567",
          rowCount: 1,
        },
      ],
      evidence: {
        snapshotId: `acc_${"b".repeat(64)}`,
        captureId: `config_${"c".repeat(64)}`,
        contentSha256: "b".repeat(64),
      },
      history: [
        {
          snapshotId: `acc_${"b".repeat(64)}`,
          state: "READY",
          capturedAt: "2026-08-01T00:00:00.000Z",
          rules: 1,
          nonCompliantResources: 1,
        },
      ],
      activation: {
        available: true,
        reason: "AWS_CONFIG_COMPLIANCE_COLLECTION_READY",
      },
      collection: { state: "ready", reason: "AWS_CONFIG_COMPLIANCE_COLLECTION_READY", lastAttemptAt: "2026-08-01T00:00:00.000Z" },
      limitations: ["No compliance inference."],
    };
    const markup = renderToStaticMarkup(
      createElement(
        dashboardModule.FinopsAwsConfigResourceComplianceReportView,
        {
          report,
          filters: {
            accountId: "",
            region: "",
            ruleName: "",
            complianceType: "",
            resourceType: "",
          },
          onFiltersChange: () => undefined,
        },
      ),
    );
    for (const value of [
      "encrypted-volumes",
      "vol-rendered",
      "111122223333",
      "AWS::EC2::Volume",
      "USD 1.234567",
      "9007199254740993",
      "AWS_CONFIG_COMPLIANCE_COLLECTION_READY",
    ])
      assert.match(markup, new RegExp(value, "u"));
    assert.doesNotMatch(markup, /fixture|sample|placeholder/iu);
    const officialMarkup = renderToStaticMarkup(
      createElement(dashboardModule.AwsConfigOfficialDefinitionPanel, {
        definition: definitionModule.AWS_CONFIG_COMPLIANCE_OFFICIAL_DEFINITION,
      }),
    );
    for (const value of [
      "7 sheets",
      "124 QuickSight visuals",
      "Tag Compliance",
      "Config Usage Insights",
      "Configuration Item Events",
      "13 · UTF-8 canonical JSON",
      "14 · UTF-8 canonical JSON",
      "does not claim QuickSight geometry or pixel parity",
    ])
      assert.match(officialMarkup, new RegExp(value, "u"));
  } finally {
    await vite.close();
  }
});
