import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Miniflare } from "miniflare";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
register(new URL("./cloudflare-loader.mjs", import.meta.url));
const runtime = await import("../db/runtime-migrations.ts");
const { ScadAllocationRepository } =
  await import("../db/finops-scad-allocation-repository.ts");
const {
  buildScadAllocationSnapshot,
  SCAD_CUR2_BASE_COLUMNS,
  SCAD_CUR2_SPLIT_COLUMNS,
} = await import("../lib/finops-scad-allocation.ts");
const { buildScadDashboard, SCAD_DASHBOARD_BOUNDS } =
  await import("../lib/finops-scad-dashboard.ts");
const { SCAD_OFFICIAL_DEFINITION } =
  await import("../lib/finops-scad-official-definition.ts");
const {
  runScadMaterializationJob,
  scadMaterializationWindow,
  scadMaterializationIdempotencyKey,
} = await import("../lib/finops-scad-materialization-job.ts");
const root = path.resolve(import.meta.dirname, "..");
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const SCOPE = {
  organizationId: "org_scad_a",
  customerId: "customer_scad_a",
  connectionId: CONNECTION_A,
};
const TRUSTED = {
  orgId: SCOPE.organizationId,
  customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId,
  partition: "aws",
  payerAccountIds: ["111111111111"],
  usageAccountIds: ["111111111111", "222222222222"],
  regions: ["us-east-1"],
};
function capture(
  character,
  completedAt = "2026-07-31T12:00:00.000Z",
  complete = true,
) {
  const generated = new Date(
    Date.parse(completedAt) - 15 * 60_000,
  ).toISOString();
  return {
    schemaVersion: "sutra.scad-allocation.capture.v1",
    scope: TRUSTED,
    captureId: `scad_${character.repeat(64)}`,
    startedAt: new Date(Date.parse(completedAt) - 20 * 60_000).toISOString(),
    completedAt,
    exportName: "sutra_cur2_scad_hourly",
    exportArn:
      "arn:aws:bcm-data-exports:us-east-1:111111111111:export/sutra-scad",
    activeGenerationId: `fbg_${character.repeat(64)}`,
    correctionOfGenerationId: null,
    manifestSha256: "d".repeat(64),
    generatedAt: generated,
    dataThroughAt: generated,
    billingPeriodStartAt: "2026-07-01T00:00:00.000Z",
    billingPeriodEndAt: "2026-08-01T00:00:00.000Z",
    scadEnabledAt: "2026-07-01T00:00:00.000Z",
    firstDeliveryObservedAt: "2026-07-02T00:00:00.000Z",
    deliverySequence: 1,
    destination: {
      bucket: "sutra-cur2-evidence-111111111111",
      prefix: "exports/scad/",
    },
    tableConfiguration: {
      tableName: "COST_AND_USAGE_REPORT",
      timeGranularity: "HOURLY",
      includeResources: "TRUE",
      includeSplitCostAllocationData: "TRUE",
    },
    coverage: {
      runtimeS3PermissionsValidated: true,
      expectedObjectCount: complete ? 1 : 2,
      processedObjectCount: 1,
      failedObjectCount: complete ? 0 : 1,
      rowsExhausted: complete,
      schemaColumns: [...SCAD_CUR2_BASE_COLUMNS, ...SCAD_CUR2_SPLIT_COLUMNS],
      errorCode: complete ? null : "S3_OBJECT_FAILED",
    },
    objects: [
      {
        objectId: "object_1",
        bucket: "sutra-cur2-evidence-111111111111",
        key: "exports/scad/period/part.gz",
        eTag: "etag",
        versionId: "version",
        sha256: "e".repeat(64),
        sizeBytes: 4096,
      },
    ],
    rows: [
      {
        lineItemId: "line-1",
        sourceObjectId: "object_1",
        sourceRowNumber: 2,
        payerAccountId: "111111111111",
        usageAccountId: "222222222222",
        region: "us-east-1",
        usageStartAt: "2026-07-30T09:00:00.000Z",
        usageEndAt: "2026-07-30T10:00:00.000Z",
        platform: "EKS",
        usageType: "USE1-EKS-vCPU-Hours",
        metric: "VCPU",
        usageUnit: "vCPU-Hours",
        currency: "USD",
        resourceId: "arn:aws:eks:us-east-1:222222222222:pod/data/spark/pod-a",
        parentResourceId: "i-123",
        resourceTags: {
          aws_eks_cluster_name: "analytics",
          aws_eks_namespace: "data",
          aws_eks_workload_type: "SparkApplication",
          aws_eks_workload_name: "spark-etl",
          CostCenter: "data-platform",
        },
        reservedUsage: "2",
        actualUsage: "3",
        splitUsage: "3",
        splitUsageRatio: "0.25",
        splitCost: "1.25",
        unusedCost: "0.25",
        netSplitCost: "1.1",
        netUnusedCost: "0.2",
        publicOnDemandSplitCost: "1.5",
        publicOnDemandUnusedCost: "0.3",
      },
    ],
  };
}
function connection(database, id, org, customer, account) {
  return database
    .prepare(
      `INSERT INTO aws_connections (id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,external_id_ciphertext,external_id_key_version,permission_pack_version,status,enabled_regions_json) VALUES (?,?,?,'aws_trust_role','aws',?,?,'ct','v1','standard-2026-08.1','active','[]')`,
    )
    .bind(
      id,
      org,
      customer,
      account,
      `arn:aws:iam::${account}:role/sutra/SutraCollectorRole`,
    );
}
async function withRepo(run) {
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `scad-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await mf.getD1Database("DB");
    runtime.resetRuntimeSchemaCacheForTests();
    await runtime.ensureRuntimeSchema(database);
    await database.batch([
      database
        .prepare(
          "INSERT INTO organizations(id,slug,name,status) VALUES (?,'scad-a','SCAD A','active')",
        )
        .bind(SCOPE.organizationId),
      database.prepare(
        "INSERT INTO organizations(id,slug,name,status) VALUES ('org_scad_b','scad-b','SCAD B','active')",
      ),
      database
        .prepare(
          "INSERT INTO customers(id,org_id,slug,name,status) VALUES (?,?,'scadc-a','SCAD CA','active')",
        )
        .bind(SCOPE.customerId, SCOPE.organizationId),
      database.prepare(
        "INSERT INTO customers(id,org_id,slug,name,status) VALUES ('customer_scad_b','org_scad_b','scadc-b','SCAD CB','active')",
      ),
      connection(
        database,
        CONNECTION_A,
        SCOPE.organizationId,
        SCOPE.customerId,
        "111111111111",
      ),
      connection(
        database,
        CONNECTION_B,
        "org_scad_b",
        "customer_scad_b",
        "999900001111",
      ),
    ]);
    await run({ database, repository: new ScadAllocationRepository(database) });
  } finally {
    await mf.dispose();
  }
}
test("complete corrected billing-period heads are immutable, tenant scoped, and partial-safe", async () => {
  await withRepo(async ({ database, repository }) => {
    const first = capture("a");
    assert.equal(
      (
        await repository.recordCapture(
          SCOPE,
          TRUSTED,
          first,
          Date.parse(first.completedAt),
        )
      ).becameActive,
      true,
    );
    const partial = capture("b", "2026-07-31T18:00:00.000Z", false);
    assert.equal(
      (
        await repository.recordCapture(
          SCOPE,
          TRUSTED,
          partial,
          Date.parse(partial.completedAt),
        )
      ).becameActive,
      false,
    );
    assert.equal(
      (await repository.listActiveSnapshots(SCOPE))[0].snapshot.captureId,
      first.captureId,
    );
    const corrected = {
      ...capture("c", "2026-08-03T12:00:00.000Z", true),
      correctionOfGenerationId: first.activeGenerationId,
      deliverySequence: 2,
    };
    const correctionResult = await repository.recordCapture(
      SCOPE,
      TRUSTED,
      corrected,
      Date.parse("2026-10-01T00:00:00.000Z"),
    );
    assert.equal(correctionResult.snapshot.snapshot.state, "STALE");
    assert.equal(correctionResult.snapshot.snapshot.complete, true);
    assert.equal(correctionResult.becameActive, true);
    assert.equal(
      (await repository.listActiveSnapshots(SCOPE))[0].snapshot.captureId,
      corrected.captureId,
    );
    assert.deepEqual(
      (await repository.listHistory(SCOPE)).map((item) => item.state),
      ["STALE", "PARTIAL", "READY"],
    );
    await assert.rejects(
      database
        .prepare(
          "UPDATE finops_scad_allocation_snapshots SET source_state='STALE'",
        )
        .run(),
      /FINOPS_SCAD_ALLOCATION_SNAPSHOT_IMMUTABLE/u,
    );
    assert.equal(
      (
        await repository.listActiveSnapshots({
          organizationId: "org_scad_b",
          customerId: "customer_scad_b",
          connectionId: CONNECTION_B,
        })
      ).length,
      0,
    );
  });
});
test("dashboard provides exact KPIs, workload/tag/TCO, framework inference, showback and zero-difference reconciliation", () => {
  const snapshot = buildScadAllocationSnapshot(
    capture("c"),
    TRUSTED,
    Date.parse("2026-07-31T12:00:00.000Z"),
  );
  const report = buildScadDashboard(
    [
      {
        generationId: `scg_${"f".repeat(64)}`,
        contentSha256: "f".repeat(64),
        snapshot,
      },
    ],
    {
      accountId: null,
      region: null,
      platform: null,
      cluster: null,
      namespace: null,
      workload: null,
      metric: null,
      tagKey: "CostCenter",
      tagValue: null,
      search: null,
      showbackBy: "TAG",
    },
    Date.parse("2026-07-31T12:00:00.000Z"),
  );
  assert.deepEqual(report.executive.total, [
    { currency: "USD", exact: { numerator: "3", denominator: "2" } },
  ]);
  assert.equal(
    report.metricKpis.find((item) => item.category === "CPU").groupCount,
    1,
  );
  assert.equal(
    report.tags.find((item) => item.key === "CostCenter").value,
    "data-platform",
  );
  assert.equal(report.tco.basis, "SCAD_TAGGED_POD_TASK_COST_ONLY");
  assert.equal(
    report.dataFrameworks.find((item) => item.framework === "SPARK").groupCount,
    1,
  );
  assert.equal(report.showback.rows[0].key, "data-platform");
  assert.equal(report.reconciliation[0].reconciled, true);
  assert.deepEqual(report.reconciliation[0].difference, {
    numerator: "0",
    denominator: "1",
  });
  assert.equal(report.periods[0].deliveryState, "FIRST_DELIVERY");
});
test("dashboard bounds high-cardinality response rows and discloses truncation", () => {
  const snapshot = buildScadAllocationSnapshot(
    capture("f"),
    TRUSTED,
    Date.parse("2026-07-31T12:00:00.000Z"),
  );
  const source = snapshot.groups[0];
  const groups = Array.from(
    { length: SCAD_DASHBOARD_BOUNDS.detailRows + 1 },
    (_, index) => ({
      ...source,
      lineage: {
        ...source.lineage,
        podOrTaskId: `pod-${String(index).padStart(5, "0")}`,
        workload: `workload-${String(index).padStart(5, "0")}`,
      },
    }),
  );
  const projection = buildScadDashboard(
    [
      {
        generationId: `scg_${"f".repeat(64)}`,
        contentSha256: "f".repeat(64),
        snapshot: { ...snapshot, groups },
      },
    ],
    {
      accountId: null,
      region: null,
      platform: null,
      cluster: null,
      namespace: null,
      workload: null,
      metric: null,
      tagKey: null,
      tagValue: null,
      search: null,
      showbackBy: "WORKLOAD",
    },
  );
  assert.equal(projection.workloads.length, SCAD_DASHBOARD_BOUNDS.detailRows);
  assert.equal(
    projection.filterOptions.workloads.length,
    SCAD_DASHBOARD_BOUNDS.filterOptions,
  );
  assert.equal(projection.projectionTruncation.workloads, true);
  assert.equal(projection.projectionTruncation.filterOptions, true);
});
test("server-owned materializer pins scope, export, S3 reads, required columns and payload", async () => {
  const seen = [];
  const value = capture("d");
  const result = await runScadMaterializationJob(
    {
      id: "job",
      orgId: SCOPE.organizationId,
      customerId: SCOPE.customerId,
      connectionId: SCOPE.connectionId,
      payload: { scheduledWindow: "2026-07-31T00:00:00.000Z" },
    },
    {
      listTargets: async () => [
        {
          scope: TRUSTED,
          exportArn: value.exportArn,
          bucket: value.destination.bucket,
          prefix: value.destination.prefix,
          lastAcceptedGenerationId: null,
        },
      ],
      adapter: {
        collect: async (request) => {
          seen.push(request);
          return value;
        },
      },
      recordCapture: async () => ({
        snapshot: {
          generationId: `scg_${"d".repeat(64)}`,
          contentSha256: "d".repeat(64),
          snapshot: { complete: true },
          scope: SCOPE,
          createdAtIso: value.completedAt,
          committedAtIso: value.completedAt,
        },
        becameActive: true,
      }),
      now: () => Date.parse(value.completedAt),
    },
  );
  assert.equal(result.acceptedHeadCount, 1);
  assert.equal(seen[0].scope.orgId, SCOPE.organizationId);
  assert.ok(seen[0].requiredColumns.includes("split_line_item_split_cost"));
  assert.deepEqual(seen[0].operations, [
    "s3:GetBucketLocation",
    "s3:ListBucket",
    "s3:GetObject",
    "s3:GetObjectAttributes",
  ]);
  assert.equal(
    scadMaterializationWindow(Date.parse("2026-07-31T18:00:00.000Z")),
    "2026-07-31T00:00:00.000Z",
  );
  assert.match(
    scadMaterializationIdempotencyKey(SCOPE, "2026-07-31T00:00:00.000Z"),
    /^scad-materialize:org_scad_a/u,
  );
});
test("route is authenticated, same-tenant, accepted-head-only and runtime-honest", async () => {
  const route = await readFile(
    new URL("../app/api/v1/finops/scad-allocation/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(
    route,
    /getConnectionForOrg\(\s*authenticated\.subject\.orgId,\s*query\.connectionId/u,
  );
  assert.match(
    route,
    /assertSessionCapability\(\s*authenticated,\s*"connection:read",\s*connection\.customerId/u,
  );
  assert.match(route, /repository\.listActiveSnapshots\(scope\)/u);
  assert.match(route, /SCAD_CUR2_MATERIALIZER_JOB_HANDLER_NOT_REGISTERED/u);
  assert.doesNotMatch(
    route,
    /searchParams\.get\("orgId"\)|searchParams\.get\("customerId"\)/u,
  );
});
test("SQLite/PostgreSQL enforce immutable complete-only period heads and PUBLIC revokes", async () => {
  for (const url of [
    new URL("../drizzle/0098_finops_scad_allocation.sql", import.meta.url),
    new URL(
      "../postgres/migrations/0093_finops_scad_allocation.sql",
      import.meta.url,
    ),
  ]) {
    const sql = await readFile(url, "utf8");
    assert.match(sql, /FINOPS_SCAD_ALLOCATION_SNAPSHOT_IMMUTABLE/u);
    assert.match(
      sql,
      /candidate\.`?complete`?\s*=\s*1|NOT candidate\.complete/u,
    );
    assert.match(
      sql,
      /candidate\.`?generated_at`?\s*>\s*active\.`?generated_at`?/u,
    );
  }
  assert.match(
    await readFile(
      new URL(
        "../postgres/migrations/0093_finops_scad_allocation.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    /REVOKE ALL ON finops_scad_allocation_snapshots FROM PUBLIC/u,
  );
});
test("native visual renders executive, CPU/GPU/RAM, explorers, frameworks, showback, reconciliation and honest gaps", async () => {
  const snapshot = buildScadAllocationSnapshot(
    capture("e"),
    TRUSTED,
    Date.parse("2026-07-31T12:00:00.000Z"),
  );
  const projection = buildScadDashboard(
    [
      {
        generationId: `scg_${"e".repeat(64)}`,
        contentSha256: "e".repeat(64),
        snapshot,
      },
    ],
    {
      accountId: null,
      region: null,
      platform: null,
      cluster: null,
      namespace: null,
      workload: null,
      metric: null,
      tagKey: null,
      tagValue: null,
      search: null,
      showbackBy: "WORKLOAD",
    },
    Date.parse("2026-07-31T12:00:00.000Z"),
  );
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    server: { middlewareMode: true },
  });
  try {
    const dashboardModule = await vite.ssrLoadModule(
      "/app/costs/finops-scad-allocation-dashboard.tsx",
    );
    const report = {
      ...projection,
      connectionId: CONNECTION_A,
      sourceState: "PARTIAL",
      officialDefinition: SCAD_OFFICIAL_DEFINITION,
      freshness: {
        dataThroughAt: snapshot.dataThroughAt,
        ageHours: 1,
        staleAfterHours: 48,
      },
      history: [],
      evidence: { acceptedHeads: [`scg_${"e".repeat(64)}`] },
      collection: {
        available: false,
        reason: "SCAD_CUR2_MATERIALIZER_JOB_HANDLER_NOT_REGISTERED",
      },
    };
    const html = renderToStaticMarkup(
      createElement(dashboardModule.ScadAllocationReportView, {
        report,
        filters: projection.filters,
        onFiltersChange: () => undefined,
      }),
    );
    for (const expected of [
      "5 named sections",
      "AWS states 3 tabs",
      "Executive KPIs",
      "CPU",
      "RAM",
      "GPU ACCELERATOR",
      "Shared / idle",
      "Workloads Explorer",
      "Cluster coverage",
      "Labels / tags explorer",
      "TCO",
      "Spark",
      "Flink",
      "EMR on EKS",
      "Showback / chargeback",
      "Reconciliation",
      "FIRST DELIVERY",
      "Container ID not published",
      "newer incomplete or corrected delivery",
    ])
      assert.match(html, new RegExp(expected, "iu"));
  } finally {
    await vite.close();
  }
});
