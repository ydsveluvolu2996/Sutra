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

test("EUC migrations enforce immutable snapshots and a complete-only monotonic head", async () => {
  const [sqlite, postgres] = await Promise.all([
    readFile(path.join(root, "drizzle/0094_finops_end_user_computing.sql"), "utf8"),
    readFile(path.join(root, "postgres/migrations/0089_finops_end_user_computing.sql"), "utf8"),
  ]);
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /FINOPS_EUC_SNAPSHOT_IMMUTABLE/u);
    assert.match(sql, /candidate\.?`?source_state`?.*READY/u);
    assert.match(sql, /candidate\.?`?observed_at`? > active\.?`?observed_at`?/u);
    assert.match(sql, /REVOKE ALL|CREATE TRIGGER/u);
  }
  const miniflare = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", compatibilityDate: "2026-05-22", d1Databases: { DB: `sutra-euc-${crypto.randomUUID()}` }, d1Persist: false });
  try {
    const database = await miniflare.getD1Database("DB");
    await database.prepare("CREATE TABLE organizations (id text PRIMARY KEY)").run();
    await database.prepare("CREATE TABLE customers (id text PRIMARY KEY)").run();
    await database.prepare("CREATE TABLE aws_connections (id text PRIMARY KEY)").run();
    for (const statement of sqlite.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) await database.prepare(statement).run();
    await database.batch([database.prepare("INSERT INTO organizations VALUES ('org_a')"), database.prepare("INSERT INTO customers VALUES ('customer_a')"), database.prepare(`INSERT INTO aws_connections VALUES ('conn_${"a".repeat(32)}')`)]);
    const insert = (id, capture, state, observed) => database.prepare(`INSERT INTO finops_euc_snapshots (generation_id,org_id,customer_id,connection_id,partition,source_capture_id,source_state,observed_at,content_sha256,snapshot_json,workspace_count,fleet_count,metric_count,cost_line_count,created_at) VALUES (?,?,?,?,?,?,?,?,?,'{}',0,0,0,0,1)`).bind(`eucg_${id.repeat(64)}`, "org_a", "customer_a", `conn_${"a".repeat(32)}`, "aws", `euc_${capture.repeat(64)}`, state, observed, id.repeat(64));
    await insert("a", "a", "READY", "2026-08-01T00:00:00.000Z").run();
    await database.prepare("INSERT INTO finops_euc_snapshot_heads VALUES (?,?,?,?,1)").bind("org_a", "customer_a", `conn_${"a".repeat(32)}`, `eucg_${"a".repeat(64)}`).run();
    await insert("b", "b", "PARTIAL", "2026-08-01T01:00:00.000Z").run();
    await assert.rejects(database.prepare("UPDATE finops_euc_snapshot_heads SET active_generation_id = ? WHERE org_id = 'org_a'").bind(`eucg_${"b".repeat(64)}`).run(), /FINOPS_EUC_HEAD_REJECTED/u);
    await assert.rejects(database.prepare("UPDATE finops_euc_snapshots SET source_state = 'PARTIAL' WHERE generation_id = ?").bind(`eucg_${"a".repeat(64)}`).run(), /FINOPS_EUC_SNAPSHOT_IMMUTABLE/u);
  } finally { await miniflare.dispose(); }
});

test("EUC repository and API enforce normalized persistence and same-tenant reads", async () => {
  const [repository, route] = await Promise.all([
    readFile(path.join(root, "db/finops-end-user-computing-repository.ts"), "utf8"),
    readFile(path.join(root, "app/api/v1/finops/end-user-computing/route.ts"), "utf8"),
  ]);
  assert.match(repository, /normalizeEndUserComputingCapture\(capture, boundary/u);
  assert.match(repository, /snapshot\.scope\.orgId !== row\.org_id/u);
  assert.match(repository, /snapshot\.state === "READY"/u);
  assert.match(repository, /contentSha256/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(route, /EUC_SIGNED_BROKER_RUNTIME_NOT_REGISTERED/u);
  assert.match(route, /userIdentifiersStored: false, sessionIdentifiersStored: false/u);
  assert.doesNotMatch(route, /ALLOWED[^\n]*(?:user|session|ipAddress|clientIp)/u);
});

test("EUC collector job pins exact reads, bounds, CUR2 and privacy exclusions", async () => {
  const { runEndUserComputingCollectionJob, EndUserComputingCollectorJobError } = await import("../lib/finops-end-user-computing-collector-job.ts");
  const boundary = { scope: { orgId: "org_a", customerId: "customer_a", connectionId: `conn_${"a".repeat(32)}` }, partition: "aws", accountIds: ["111122223333"], regions: ["us-east-1"] };
  const capture = { scope: { ...boundary.scope }, partition: boundary.partition, accountIds: [...boundary.accountIds], regions: [...boundary.regions], captureId: `euc_${"b".repeat(64)}` };
  let request;
  const result = await runEndUserComputingCollectionJob({ boundary, nowMs: 1_785_552_000_000,
    broker: { collect: async (value) => { request = value; return capture; } },
    store: { recordCapture: async () => ({ generation: { generationId: `eucg_${"c".repeat(64)}`, snapshot: { captureId: capture.captureId, state: "READY" } }, becameActive: true }) },
  });
  assert.equal(request.operations.length, 8);
  assert.equal(request.canonicalBillingSource, "ACTIVE_RECONCILED_CUR2_GENERATION");
  assert.deepEqual(Object.values(request.privacy), [false, false, false, false, false]);
  assert.equal(request.bounds.maximumConcurrency, 4);
  assert.equal(result.becameActive, true);
  await assert.rejects(runEndUserComputingCollectionJob({ boundary,
    broker: { collect: async () => ({ ...capture, scope: { ...capture.scope, orgId: "org_b" } }) },
    store: { recordCapture: async () => { throw new Error("must not persist"); } },
  }), (error) => error instanceof EndUserComputingCollectorJobError && !/must not persist/u.test(error.message));
});

test("native EUC report renders all six official areas with explicit privacy and source gaps", async () => {
  const vite = await createServer({ root, configFile: false, logLevel: "silent", plugins: [react()], server: { middlewareMode: true } });
  try {
    const dashboardModule = await vite.ssrLoadModule("/app/costs/finops-end-user-computing-dashboard.tsx");
    const dashboard = {
      schemaVersion: "sutra.end-user-computing-dashboard.v1", state: "PARTIAL",
      sourceEvidence: { captureId: `euc_${"a".repeat(64)}`, observedAt: "2026-08-01T01:00:00.000Z", billingGenerationId: `fbg_${"b".repeat(64)}`, billingPeriod: "2026-08", freshness: { inventory: "CURRENT", activity: "CURRENT", metrics: "CURRENT", costs: "CURRENT" } },
      accountRegionCoverage: [], inventory: { workspaceCount: 1, availableWorkspaces: 1, stoppedWorkspaces: 0, otherStateWorkspaces: 0, bundleCount: 1, fleetCount: 1, runningFleets: 1, stoppedFleets: 0, otherStateFleets: 0, stackCount: 1 },
      activity: { workspaceConnections: { connected: 0, disconnected: 1, unknown: 0, missing: 0 }, appStreamSessions: { active: 2, pending: 1, expired: 0, connected: 2, notConnected: 1 } },
      telemetry: [{ service: "WORKSPACES", metricName: "WORKSPACES_IN_SESSION_LATENCY", evidenceKind: "PERFORMANCE", evidenceState: "OBSERVED", observations: [] }],
      costViews: [{ service: "WORKSPACES", currency: "USD", lineCount: 1, totals: [{ basis: "net", totalMicros: "12000000", contributingLineCount: 1, missingLineCount: 0, coverage: "COMPLETE" }], usage: [], commitments: [] }],
      resources: [{ accountId: "111122223333", region: "us-east-1", workspaceId: "ws-12345678", bundleId: "wsb-12345678", state: "AVAILABLE", runningMode: "ALWAYS_ON", computeType: "STANDARD", rootVolumeGib: 80, userVolumeGib: 50, observedAt: "2026-08-01T01:00:00.000Z", connection: { state: "DISCONNECTED", observedAt: "2026-08-01T01:00:00.000Z" } }], nextCursor: null,
      separation: { inventoryActivitySource: "AWS_CONTROL_PLANE", performanceSource: "CLOUDWATCH_ONLY", costSource: "ACTIVE_RECONCILED_CUR2_ONLY", crossSourceInference: false }, limitations: ["No cross-source inference."],
    };
    const report = { schema: "sutra.finops-end-user-computing-dashboard.v1", connectionId: `conn_${"a".repeat(32)}`, sourceState: "partial", dashboard,
      history: [{ generationId: `eucg_${"c".repeat(64)}`, sourceState: "PARTIAL", observedAtIso: "2026-08-01T01:00:00.000Z", workspaceCount: 1, fleetCount: 1, metricCount: 1, costLineCount: 1 }],
      freshness: { dataThroughAt: "2026-08-01T00:00:00.000Z", ageHours: 1, staleAfterHours: 48 }, evidence: {}, collection: { jobContractAvailable: true, providerAdapterAvailable: false, reason: "EUC_SIGNED_BROKER_RUNTIME_NOT_REGISTERED" },
      privacy: { userIdentifiersStored: false }, unsupportedOfficialViews: ["Protocol unavailable"],
    };
    const html = renderToStaticMarkup(createElement(dashboardModule.FinopsEndUserComputingReportView, { report, service: "ALL", onServiceChange: () => undefined }));
    for (const text of ["Service and cost summary", "WorkSpaces insights", "WorkSpaces usage and logons", "Optional CloudWatch performance", "AppStream 2.0 overview", "Cost-optimization review candidates", "neither persisted nor returned", "not savings claims", "three-month", "Last logon", "Evidence, coverage"]) assert.match(html, new RegExp(text, "iu"));
    assert.doesNotMatch(html, /sample|fixture|placeholder/iu);
  } finally { await vite.close(); }
});
