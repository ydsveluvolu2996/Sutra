import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { Miniflare } from "miniflare";
import { createServer } from "vite";
const root = path.resolve(import.meta.dirname, "..");
test("Extended Support migrations enforce immutable READY-only monotonic accepted heads", async () => {
  const [sqlite, pg] = await Promise.all([
    readFile(
      path.join(root, "drizzle/0102_finops_extended_support_projection.sql"),
      "utf8",
    ),
    readFile(
      path.join(
        root,
        "postgres/migrations/0097_finops_extended_support_projection.sql",
      ),
      "utf8",
    ),
  ]);
  for (const sql of [sqlite, pg]) {
    assert.match(sql, /FINOPS_EXTENDED_SUPPORT_SNAPSHOT_IMMUTABLE/u);
    assert.match(sql, /candidate\.?`?source_state`?.*READY/u);
    assert.match(
      sql,
      /candidate\.?`?collected_at`?>active\.?`?collected_at`?/u,
    );
  }
  const mf = new Miniflare({
    modules: true,
    script: "export default{fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `es-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.prepare("CREATE TABLE organizations(id text PRIMARY KEY)").run();
    await db.prepare("CREATE TABLE customers(id text PRIMARY KEY)").run();
    await db.prepare("CREATE TABLE aws_connections(id text PRIMARY KEY)").run();
    for (const s of sqlite
      .split("--> statement-breakpoint")
      .map((x) => x.trim())
      .filter(Boolean))
      await db.prepare(s).run();
    await db.batch([
      db.prepare("INSERT INTO organizations VALUES('org_a')"),
      db.prepare("INSERT INTO customers VALUES('customer_a')"),
      db.prepare(
        `INSERT INTO aws_connections VALUES('conn_${"a".repeat(32)}')`,
      ),
    ]);
    const insert = (hex, state, ready, partial, required, at) =>
      db
        .prepare(
          `INSERT INTO finops_extended_support_snapshots(generation_id,org_id,customer_id,connection_id,management_account_id,partition,collection_id,source_state,content_sha256,snapshot_json,collected_at,resource_count,ready_service_count,partial_service_count,configuration_required_service_count,created_at)VALUES(?,?,?,?,?,'aws',?,?,?,?,?,0,?,?,?,1)`,
        )
        .bind(
          `espg_${hex.repeat(64)}`,
          "org_a",
          "customer_a",
          `conn_${"a".repeat(32)}`,
          "111122223333",
          `esp_${hex.repeat(64)}`,
          state,
          hex.repeat(64),
          "{}",
          at,
          ready,
          partial,
          required,
        );
    await insert("a", "READY", 5, 0, 0, "2026-08-01T00:00:00.000Z").run();
    await db
      .prepare("INSERT INTO finops_extended_support_heads VALUES(?,?,?,?,1)")
      .bind(
        "org_a",
        "customer_a",
        `conn_${"a".repeat(32)}`,
        `espg_${"a".repeat(64)}`,
      )
      .run();
    await insert("b", "PARTIAL", 4, 1, 0, "2026-08-01T01:00:00.000Z").run();
    await assert.rejects(
      db
        .prepare(
          "UPDATE finops_extended_support_heads SET active_generation_id=? WHERE org_id='org_a'",
        )
        .bind(`espg_${"b".repeat(64)}`)
        .run(),
      /FINOPS_EXTENDED_SUPPORT_HEAD_REJECTED/u,
    );
    await assert.rejects(
      db
        .prepare(
          "UPDATE finops_extended_support_snapshots SET source_state='PARTIAL' WHERE generation_id=?",
        )
        .bind(`espg_${"a".repeat(64)}`)
        .run(),
      /FINOPS_EXTENDED_SUPPORT_SNAPSHOT_IMMUTABLE/u,
    );
  } finally {
    await mf.dispose();
  }
});
test("exact money seal converts signed six-decimal amounts without floating aggregation", async () => {
  const { extendedSupportMoneyToMicros } =
    await import("../lib/finops-extended-support-dashboard.ts");
  assert.equal(extendedSupportMoneyToMicros(0.1), "100000");
  assert.equal(extendedSupportMoneyToMicros(17.250001), "17250001");
  assert.equal(extendedSupportMoneyToMicros(-0.000001), "-1");
  assert.equal(extendedSupportMoneyToMicros(-0), "0");
  assert.equal(
    (
      BigInt(extendedSupportMoneyToMicros(0.1)) +
      BigInt(extendedSupportMoneyToMicros(0.2))
    ).toString(),
    "300000",
  );
  assert.throws(() => extendedSupportMoneyToMicros(Number.NaN));
  assert.throws(() => extendedSupportMoneyToMicros(1_000_000_000_001));
});
test("repository, API and projection omit resource ARNs and enforce authenticated tenant reads", async () => {
  const [repo, route, dashboard] = await Promise.all([
    readFile(
      path.join(root, "db/finops-extended-support-repository.ts"),
      "utf8",
    ),
    readFile(
      path.join(root, "app/api/v1/finops/extended-support-projection/route.ts"),
      "utf8",
    ),
    readFile(
      path.join(root, "lib/finops-extended-support-dashboard.ts"),
      "utf8",
    ),
  ]);
  assert.match(repo, /buildExtendedSupportProjection\(capture,boundary/u);
  assert.match(repo, /if\(snapshot\.state==="READY"\)/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\(\s*auth\.subject\.orgId/u);
  assert.match(
    route,
    /assertSessionCapability\(auth,\s*"connection:read",\s*connection\.customerId\)/u,
  );
  assert.match(
    route,
    /projectionIsInvoice:\s*false,\s*projectionIsSavingsPromise:\s*false/u,
  );
  assert.ok(route.match(/EXTENDED_SUPPORT_OFFICIAL_DEFINITION/gu)?.length >= 3);
  assert.doesNotMatch(dashboard, /resourceArn:/u);
  assert.match(dashboard, /projectedIncrementalCostMicros/u);
});
test("multi-account collection contract pins five-service reads, authoritative evidence and CUR2", async () => {
  const m = await import("../lib/finops-extended-support-collector-job.ts"),
    boundary = {
      scope: {
        orgId: "org_a",
        customerId: "customer_a",
        connectionId: `conn_${"a".repeat(32)}`,
      },
      managementAccountId: "111122223333",
      partition: "aws",
      accountIds: ["111122223333", "222233334444"],
      regions: ["us-east-1", "us-west-2"],
    };
  let request;
  const capture = {
    scope: boundary.scope,
    managementAccountId: boundary.managementAccountId,
    partition: boundary.partition,
    accountIds: boundary.accountIds,
    regions: boundary.regions,
    collectionId: `esp_${"b".repeat(64)}`,
  };
  const result = await m.runExtendedSupportCollectionJob({
    boundary,
    nowMs: 1785552000000,
    broker: { collect: async (x) => ((request = x), capture) },
    store: {
      recordCapture: async () => ({
        snapshot: {
          generationId: `espg_${"c".repeat(64)}`,
          snapshot: { collectionId: capture.collectionId, state: "READY" },
        },
        becameActive: true,
      }),
    },
  });
  assert.equal(request.inventoryScope, "SERVER_PINNED_ACCOUNT_REGION_FANOUT");
  assert.equal(
    request.lifecycleSource,
    "AUTHORITATIVE_AWS_API_OR_DOCUMENTATION",
  );
  assert.equal(request.pricingSource, "AWS_PRICE_LIST_OR_PUBLIC_PRICING");
  assert.equal(request.actualCostSource, "ACTIVE_RECONCILED_CUR2_GENERATION");
  assert.ok(request.operations.includes("elasticache:DescribeCacheClusters"));
  assert.ok(request.operations.includes("eks:DescribeCluster"));
  assert.ok(request.operations.includes("rds:DescribeDBInstances"));
  assert.ok(request.operations.includes("es:DescribeDomain"));
  assert.equal(result.becameActive, true);
  await assert.rejects(
    m.runExtendedSupportCollectionJob({
      boundary,
      broker: {
        collect: async () => ({ ...capture, accountIds: ["999999999999"] }),
      },
      store: {
        recordCapture: async () => {
          throw new Error("must not persist");
        },
      },
    }),
    (e) =>
      e instanceof m.ExtendedSupportCollectorJobError &&
      !/must not persist/u.test(e.message),
  );
});
test("native Extended Support report renders eligibility, dates, horizons, drilldowns and remediation", async () => {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    server: { middlewareMode: true },
  });
  try {
    const [m, official] = await Promise.all([
        vite.ssrLoadModule(
          "/app/costs/finops-extended-support-projection-dashboard.tsx",
        ),
        vite.ssrLoadModule(
          "/lib/finops-extended-support-official-definition.ts",
        ),
      ]),
      filters = {
        service: "",
        accountId: "",
        region: "",
        lifecycleState: "",
        engine: "",
        horizon: "3",
      },
      money = { currency: "USD", amountMicros: "1250000000" },
      resource = {
        service: "RDS",
        resourceType: "RDS_DB_INSTANCE",
        accountId: "111122223333",
        region: "us-east-1",
        resourceId: "database-prod",
        engine: "postgres",
        engineVersion: "11.22",
        supportVersionKey: "postgres-11",
        supportEnrollment: "AUTOMATIC",
        lifecycleState: "EXTENDED_SUPPORT",
        standardSupportEndAt: "2026-01-01T00:00:00.000Z",
        extendedSupportStartAt: "2026-01-01T00:00:00.000Z",
        chargeableFromAt: "2026-02-01T00:00:00.000Z",
        extendedSupportEndAt: "2028-01-01T00:00:00.000Z",
        calendarEffectiveAt: "2026-07-01T00:00:00.000Z",
        calendarFreshness: "CURRENT",
        pricingRateIds: ["rate-rds"],
        pricingFreshness: "CURRENT",
        latestObservedAt: "2026-07-31T00:00:00.000Z",
        observationFreshness: "CURRENT",
        projectionBasis: {
          unit: "VCPU_HOUR",
          unitsPerHour: 4,
          observedAt: "2026-07-31T00:00:00.000Z",
        },
        observedActualCosts: [{ currency: "USD", amountMicros: "100000000" }],
        horizon: {
          months: 3,
          windowStartAt: "2026-08-01T00:00:00.000Z",
          windowEndAt: "2026-11-01T00:00:00.000Z",
          supportUnitHours: 8832,
          pricingCoveredUnitHours: 8832,
          projectionState: "COMPLETE",
          projectedIncrementalCostMicros: "1250000000",
          currency: "USD",
          reasonCodes: ["UNCHANGED_RESOURCE_CONFIGURATION_ASSUMED"],
        },
        sourceReferenceIds: ["calendar-rds", "rate-rds"],
      },
      service = {
        service: "RDS",
        state: "READY",
        resourceCount: 1,
        currentExtended: 1,
        endOfSupport: 0,
        configurationRequired: 0,
        actualCosts: [{ currency: "USD", amountMicros: "100000000" }],
        horizon: {
          months: 3,
          windowStartAt: "2026-08-01T00:00:00.000Z",
          windowEndAt: "2026-11-01T00:00:00.000Z",
          currentlyExtendedResources: 1,
          enteringExtendedSupportResources: 0,
          endOfSupportResources: 0,
          completeResourceProjections: 1,
          partialResourceProjections: 0,
          configurationRequiredResources: 0,
          projectedIncrementalCosts: [money],
        },
      },
      report = {
        schema: "sutra.finops-extended-support-dashboard.v1",
        connectionId: `conn_${"a".repeat(32)}`,
        sourceState: "partial",
        officialDefinition: official.EXTENDED_SUPPORT_OFFICIAL_DEFINITION,
        dashboard: {
          filters: {},
          filterOptions: {
            services: ["RDS", "AURORA", "EKS", "OPENSEARCH", "ELASTICACHE"],
            accounts: ["111122223333"],
            regions: ["us-east-1"],
            lifecycleStates: ["EXTENDED_SUPPORT"],
            engines: ["postgres"],
          },
          labels: {
            actual: "RECONCILED_ACTUAL_EXTENDED_SUPPORT_COST",
            projection:
              "PROJECTED_INCREMENTAL_EXTENDED_SUPPORT_COST_IF_UNCHANGED",
          },
          services: [service],
          resources: [resource],
          resourcesTruncated: false,
          resultCount: 1,
          limitations: ["PROJECTION_IS_INCREMENTAL_EXTENDED_SUPPORT_ONLY"],
        },
        history: [
          {
            generationId: `espg_${"d".repeat(64)}`,
            collectionId: `esp_${"e".repeat(64)}`,
            state: "READY",
            collectedAt: "2026-07-31T00:00:00.000Z",
            resourceCount: 1,
            readyServiceCount: 5,
            partialServiceCount: 0,
            configurationRequiredServiceCount: 0,
          },
        ],
        freshness: {
          collectedAt: "2026-07-31T00:00:00.000Z",
          ageHours: 24,
          staleAfterHours: 48,
        },
        coverage: [
          {
            service: "RDS",
            state: "READY",
            status: "SUCCEEDED",
            readPermissionsValidated: true,
            accountCount: 1,
            regionCount: 1,
            recordCount: 1,
            errorCode: null,
          },
        ],
        provenance: {
          generationId: `espg_${"d".repeat(64)}`,
          activeGenerationId: `espg_${"d".repeat(64)}`,
          latestGenerationId: `espg_${"f".repeat(64)}`,
          newerIncomplete: true,
          collectionId: `esp_${"e".repeat(64)}`,
          contentSha256: "d".repeat(64),
          managementAccountId: "111122223333",
          partition: "aws",
          accountCount: 1,
          regionCount: 1,
          sourceReferences: [
            {
              id: "calendar-rds",
              kind: "AWS_API",
              operation: "rds:DescribeDBMajorEngineVersions",
              retrievedAt: "2026-07-31T00:00:00.000Z",
              effectiveAt: "2026-07-01T00:00:00.000Z",
              sha256: "a".repeat(64),
            },
          ],
        },
        semantics: {
          actualCostLabel: "RECONCILED_ACTUAL_EXTENDED_SUPPORT_COST",
          projectionLabel:
            "PROJECTED_INCREMENTAL_EXTENDED_SUPPORT_COST_IF_UNCHANGED",
          moneyRepresentation:
            "SIGNED_INTEGER_MICROS_AFTER_ENGINE_SIX_DECIMAL_SEAL",
          projectionIsInvoice: false,
          projectionIsSavingsPromise: false,
        },
        collection: {
          jobContractAvailable: true,
          providerAdapterAvailable: false,
          reason: "EXTENDED_SUPPORT_MULTI_ACCOUNT_ADAPTER_NOT_DEPLOYED",
        },
      };
    const html = renderToStaticMarkup(
      createElement(m.ExtendedSupportProjectionReportView, {
        report,
        filters,
        onFiltersChange: () => undefined,
      }),
    );
    for (const text of [
      "Incremental projection, not a bill or savings promise",
      "Official AWS definition coverage",
      "5 sheets · 60 visuals · 17 controls",
      "RDS Extended Support (Cost Projection)",
      "EKS Extended Support (Cost Projection)",
      "OpenSearch Extended Support (Cost Projection)",
      "ElastiCache Extended Support (Cost Projection)",
      "Service projection portfolio",
      "ElastiCache · EKS · RDS/Aurora · OpenSearch",
      "Engine/version eligibility and remediation plan",
      "Standard end",
      "Calendar effective",
      "Monthly planning timeline",
      "Prioritize upgrade or migration",
      "Authoritative evidence",
    ])
      assert.ok(
        html.includes(text),
        `Expected rendered report to include: ${text}`,
      );
    assert.doesNotMatch(html, /sample|fixture|placeholder/iu);
  } finally {
    await vite.close();
  }
});
