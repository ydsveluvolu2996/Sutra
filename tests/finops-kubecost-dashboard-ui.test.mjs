import assert from "node:assert/strict";
import path from "node:path";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * ADD-06 Kubecost Containers Cost Allocation UI.
 *
 * Renders each of the three AWS-documented purpose tabs against a realistic
 * projection of the canonical engine and asserts the vertical's honesty rules:
 * exact rational money is never rounded to look tidy, idle and unallocated
 * cluster cost is named rather than folded into workloads, a withheld percentage
 * says why, missing dimensions are labelled unavailable instead of zero,
 * negative amounts keep their sign, OpenCost stays labelled as supplemental, and
 * node capacity/instance sizing is presented as unavailable.
 */

const root = path.resolve(import.meta.dirname, "..");
const connection = `conn_${"a".repeat(32)}`;

const vite = await createServer({
  root,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const dashboard = await vite.ssrLoadModule("/app/costs/finops-kubecost-allocation-dashboard.tsx");
const definition = (await vite.ssrLoadModule("/lib/finops-kubecost-official-definition.ts"))
  .KUBECOST_OFFICIAL_DEFINITION;
const { buildKubecostDashboard } = await import("../lib/finops-kubecost-dashboard.ts");
after(async () => vite.close());

const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const exact = (numerator, denominator = "1") => ({ numerator, denominator });

function efficiency(metric, used, requested) {
  return {
    metric,
    unit: metric === "CPU" ? "core-hours" : "byte-hours",
    requestedOrProvisioned: requested === null ? null : exact(requested),
    used: used === null ? null : exact(used),
    ratio: used === null || requested === null ? null : exact(used, requested),
    state: used === null || requested === null ? "UNAVAILABLE" : "COMPLETE",
    evidenceBasis: used === null ? "NOT_PUBLISHED" : "EXPLICIT_SOURCE_FIELDS",
  };
}

function group(overrides = {}) {
  return {
    usageAccountId: "111122223333",
    region: "us-east-1",
    clusterId: "eks-prod",
    namespace: "payments",
    controllerKind: "Deployment",
    controller: "payments-api",
    workload: "payments-api",
    pod: "payments-api-1",
    container: "api",
    node: "ip-10-0-1-10",
    nodeInstanceType: "m7g.large",
    nodeAvailabilityZone: "us-east-1a",
    nodeCapacityType: "ON_DEMAND",
    nodeArchitecture: "arm64",
    nodeOs: "linux",
    nodeGroup: "payments-arm",
    nodeGroupImage: "ami-0123456789abcdef0",
    allocationKind: "WORKLOAD",
    currency: "USD",
    rowCount: 1,
    totalCost: exact("10"),
    componentCosts: [{ component: "CPU", exact: exact("6") }, { component: "RAM", exact: exact("4") }],
    hourlyCosts: [{
      windowStartIso: "2026-07-31T00:00:00.000Z",
      windowEndIso: "2026-08-01T00:00:00.000Z",
      currency: "USD",
      totalCost: exact("10"),
      componentCosts: [{ component: "CPU", exact: exact("6") }, { component: "RAM", exact: exact("4") }],
      rowCount: 1,
    }],
    efficiencies: [efficiency("CPU", "1", "3"), efficiency("RAM", "50", "100")],
    sourceRowIds: ["row-1"],
    sourceRowsTruncated: false,
    ...overrides,
  };
}

/**
 * Realistic snapshot: a workload group, an idle group, an unallocated group with
 * no namespace and no published node dimensions, a spot workload, a container
 * with no published request/usage pair, and a negative credited external group.
 */
function snapshot() {
  return {
    schemaVersion: "sutra.kubecost-allocation.snapshot.v1",
    scope: {
      orgId: "org_a",
      customerId: "customer_a",
      connectionId: connection,
      partition: "aws",
      billingPeriod: "2026-08",
      activeCur2GenerationId: `fbg_${"b".repeat(64)}`,
      awsAccountIds: ["111122223333", "444455556666"],
      clusterIds: ["eks-prod", "eks-dev"],
    },
    captureId: `kubecost_${"c".repeat(64)}`,
    state: "READY",
    complete: true,
    generatedAtIso: "2026-08-01T01:00:00.000Z",
    dataThroughAtIso: "2026-08-01T00:00:00.000Z",
    ageHours: 1,
    exportLineage: {
      provider: "KUBECOST",
      exporterName: "kubecost-s3-exporter",
      exporterVersion: "1.4.0",
      schemaName: "sutra.kubecost-opencost-allocation",
      schemaVersion: "2.0.0",
      schemaSha256: "1".repeat(64),
      manifestSha256: "2".repeat(64),
      querySha256: "3".repeat(64),
      costModelSha256: "4".repeat(64),
      objectCount: 3,
      versionPinnedObjectCount: 3,
    },
    coverage: {
      expectedObjects: 3,
      processedObjects: 3,
      failedObjects: 0,
      expectedClusters: 2,
      capturedClusters: 2,
      rowsExhausted: false,
    },
    rowCount: 6,
    groupCount: 6,
    categoryTotals: [{ category: "WORKLOAD_ALLOCATION", currency: "USD", exact: exact("14"), rowCount: 2 }],
    groups: [
      group(),
      group({
        usageAccountId: "444455556666",
        clusterId: "eks-dev",
        namespace: "analytics",
        controller: "worker",
        workload: "worker",
        pod: "worker-1",
        container: "worker",
        nodeCapacityType: "SPOT",
        nodeInstanceType: "c7g.large",
        totalCost: exact("4"),
        componentCosts: [{ component: "CPU", exact: exact("3") }, { component: "RAM", exact: exact("1") }],
        hourlyCosts: [{
          windowStartIso: "2026-07-31T00:00:00.000Z",
          windowEndIso: "2026-08-01T00:00:00.000Z",
          currency: "USD",
          totalCost: exact("4"),
          componentCosts: [{ component: "CPU", exact: exact("3") }],
          rowCount: 1,
        }],
        sourceRowIds: ["row-2"],
      }),
      // Idle cluster capacity: no namespace, no workload, its own named kind.
      group({
        allocationKind: "IDLE",
        namespace: null,
        controllerKind: null,
        controller: null,
        workload: null,
        pod: null,
        container: null,
        totalCost: exact("7"),
        componentCosts: [{ component: "CPU", exact: exact("5") }, { component: "RAM", exact: exact("2") }],
        efficiencies: [efficiency("CPU", null, null), efficiency("RAM", null, null)],
        hourlyCosts: [{
          windowStartIso: "2026-07-31T00:00:00.000Z",
          windowEndIso: "2026-08-01T00:00:00.000Z",
          currency: "USD",
          totalCost: exact("7"),
          componentCosts: [{ component: "CPU", exact: exact("5") }],
          rowCount: 1,
        }],
        sourceRowIds: ["row-3"],
      }),
      // Unallocated cluster cost with no published node dimensions at all.
      group({
        allocationKind: "UNALLOCATED",
        namespace: null,
        controllerKind: null,
        controller: null,
        workload: null,
        pod: null,
        container: null,
        node: null,
        nodeInstanceType: null,
        nodeCapacityType: null,
        nodeArchitecture: null,
        nodeGroup: null,
        nodeGroupImage: null,
        totalCost: exact("1", "3"),
        componentCosts: [{ component: "CPU", exact: exact("1", "3") }],
        efficiencies: [efficiency("CPU", null, null)],
        hourlyCosts: [{
          windowStartIso: "2026-07-31T00:00:00.000Z",
          windowEndIso: "2026-08-01T00:00:00.000Z",
          currency: "USD",
          totalCost: exact("1", "3"),
          componentCosts: [{ component: "CPU", exact: exact("1", "3") }],
          rowCount: 1,
        }],
        sourceRowIds: ["row-4"],
      }),
      // A cluster whose only container publishes no request/usage pair at all:
      // its efficiency is unmeasured, not efficient and not zero.
      group({
        clusterId: "eks-batch",
        namespace: "search",
        controller: "indexer",
        workload: "indexer",
        pod: "indexer-1",
        container: "indexer",
        totalCost: exact("25", "2"),
        componentCosts: [{ component: "CPU", exact: exact("25", "2") }],
        efficiencies: [efficiency("CPU", null, null), efficiency("RAM", null, null)],
        hourlyCosts: [{
          windowStartIso: "2026-07-31T00:00:00.000Z",
          windowEndIso: "2026-08-01T00:00:00.000Z",
          currency: "USD",
          totalCost: exact("25", "2"),
          componentCosts: [{ component: "CPU", exact: exact("25", "2") }],
          rowCount: 1,
        }],
        sourceRowIds: ["row-5"],
      }),
      // A credited external cost: negative, and it must keep its sign.
      group({
        allocationKind: "EXTERNAL",
        namespace: "shared-services",
        controllerKind: null,
        controller: null,
        workload: null,
        pod: null,
        container: null,
        totalCost: exact("-3"),
        componentCosts: [{ component: "EXTERNAL", exact: exact("-3") }],
        efficiencies: [],
        hourlyCosts: [{
          windowStartIso: "2026-07-31T00:00:00.000Z",
          windowEndIso: "2026-08-01T00:00:00.000Z",
          currency: "USD",
          totalCost: exact("-3"),
          componentCosts: [{ component: "EXTERNAL", exact: exact("-3") }],
          rowCount: 1,
        }],
        sourceRowIds: ["row-6"],
      }),
    ],
    reconciliation: {
      state: "MISMATCH",
      authoritativeSpendSource: "AWS_CUR2_ACTIVE_GENERATION",
      presentationPolicy: "ATTRIBUTION_VIEW_ONLY_DO_NOT_ADD_TO_CUR2",
      toleranceMicros: "0",
      currencies: [
        {
          currency: "USD",
          kubecostTotal: exact("100", "3"),
          cur2TotalMicros: "33000000",
          delta: exact("1", "3"),
          withinTolerance: false,
        },
        {
          currency: "EUR",
          kubecostTotal: exact("5"),
          cur2TotalMicros: null,
          delta: null,
          withinTolerance: null,
        },
      ],
    },
    limitations: ["Allocation only."],
  };
}

function envelope(overrides = {}) {
  const projection = buildKubecostDashboard(snapshot());
  return {
    ...projection,
    connectionId: connection,
    sourceState: "complete",
    officialDefinition: definition,
    history: [],
    freshness: { dataThroughAt: "2026-08-01T00:00:00.000Z", ageHours: 1, staleAfterHours: 24 },
    evidence: {
      generationId: `kcg_${"d".repeat(64)}`,
      activeGenerationId: `kcg_${"d".repeat(64)}`,
      latestGenerationId: `kcg_${"d".repeat(64)}`,
      sourceCaptureId: `kubecost_${"c".repeat(64)}`,
      contentSha256: "5".repeat(64),
      activeCur2GenerationId: `fbg_${"b".repeat(64)}`,
      billingPeriod: "2026-08",
      newerIncomplete: false,
    },
    collection: {
      jobContractAvailable: true,
      providerAdapterAvailable: true,
      runtimeState: "ready",
      sharedWorkerRegistered: false,
      reason: "AWAITING_SHARED_REGISTRY_HOOK",
    },
    disclosures: ["Kubecost is an allocation view only; do not add it to authoritative CUR2 spend."],
    ...overrides,
  };
}

const AREAS = definition.documentedAreas.map((area) => area.name);

test("every AWS-documented purpose tab renders real content", () => {
  assert.deepEqual(AREAS, ["Executive Summary", "Workloads Explorer", "EKS Breakdown"]);
  for (const area of definition.documentedAreas) {
    const html = render(dashboard.FinopsKubecostAreaContent, { report: envelope(), area });
    assert.ok(html.length > 800, `${area.name} rendered almost nothing`);
    // Each area discloses its own documented purpose through the tab shell.
    const shell = render(dashboard.FinopsKubecostAllocationSheets, {
      report: envelope(), initialAreaName: area.name,
    });
    assert.ok(shell.includes(area.documentedPurpose), `${area.name} purpose missing`);
    assert.ok(shell.includes(area.remainingGap), `${area.name} remaining gap missing`);
  }
});

test("the three documented tabs are real tabs and no object totals are invented", () => {
  const html = render(dashboard.FinopsKubecostAllocationSheets, { report: envelope() });
  assert.equal((html.match(/role="tab"/gu) ?? []).length, 3);
  assert.equal((html.match(/role="tabpanel"/gu) ?? []).length, 1);
  assert.equal((html.match(/aria-selected="true"/gu) ?? []).length, 1);
  assert.ok(html.includes("3</b> AWS-documented purpose tabs"));
  assert.ok(
    html.includes("official visual and control totals: <b>unavailable</b>"),
    "unpublished QuickSight object totals must be stated as unavailable",
  );
  assert.ok(html.includes("62 columns"), "the pinned dataset column count must be shown");
});

test("money is exact: a non-terminating amount is a fraction, not a rounded number", () => {
  const html = render(dashboard.FinopsKubecostAreaContent, {
    report: envelope(), area: definition.documentedAreas[1],
  });
  // 1/3 of a currency unit has no terminating decimal and must not be printed as 0.33.
  assert.ok(
    html.includes("USD exactly 1/3 (no terminating decimal)"),
    "a non-terminating exact amount must be disclosed as a fraction",
  );
  assert.equal(html.includes("USD 0.33<"), false);
  // 25/2 does terminate and is printed exactly.
  assert.ok(html.includes("USD 12.50"), "a terminating exact amount must be printed exactly");
  // Negative external cost keeps its sign (unicode minus).
  assert.ok(html.includes("USD −3.00"), "a negative amount must keep its sign");
});

test("idle and unallocated cluster cost are named shares, never folded into workloads", () => {
  const html = render(dashboard.FinopsKubecostAreaContent, {
    report: envelope(), area: definition.documentedAreas[0],
  });
  assert.ok(html.includes("Idle cluster capacity (named, never shared onto workloads)"));
  assert.ok(html.includes("Unallocated cluster cost (named, never shared onto workloads)"));
  assert.ok(html.includes("shareIdle=false"), "the export contract idle flags must be shown");
  assert.ok(html.includes("splitIdle=true"));
  assert.ok(
    html.includes("no idle or unallocated cost is silently distributed onto a workload"),
    "the non-distribution rule must be stated",
  );
  // Idle cost is 7 exactly, and is reported on its own row.
  assert.ok(html.includes("USD 7.00"), "the exact idle amount must be shown");
  // The showback view names unallocated cluster cost instead of spreading it.
  const workloads = render(dashboard.FinopsKubecostAreaContent, {
    report: envelope(), area: definition.documentedAreas[1],
  });
  assert.ok(workloads.includes("Showback / chargeback evidence"));
  assert.ok(workloads.includes("Unallocated cluster cost (named, not distributed)"));
  assert.ok(
    workloads.includes("No invoice, journal entry, transfer or chargeback"),
    "showback must state that it posts nothing",
  );
});

test("a share is refused rather than drawn when a part is negative", () => {
  const html = render(dashboard.FinopsKubecostAreaContent, {
    report: envelope(), area: definition.documentedAreas[0],
  });
  assert.ok(
    html.includes("at least one kind carries a negative amount"),
    "a composition containing a negative part must be withheld with its reason",
  );
});

test("missing evidence is labelled, never zero", () => {
  const executive = render(dashboard.FinopsKubecostAreaContent, {
    report: envelope(), area: definition.documentedAreas[0],
  });
  // Kinds with no group on the page are absent evidence.
  assert.ok(executive.includes("Not present in this page of evidence"));
  // Clusters whose groups publish no request/usage pair are unmeasured.
  assert.ok(executive.includes("Not measured"));
  assert.ok(executive.includes("Not published"));

  const workloads = render(dashboard.FinopsKubecostAreaContent, {
    report: envelope(), area: definition.documentedAreas[1],
  });
  assert.ok(workloads.includes("Node not published"));
  assert.ok(workloads.includes("Instance type not published"));
  assert.ok(workloads.includes("Capacity type not published"));
  assert.ok(
    workloads.includes("Not measured — the accepted export carries no request/usage pair for this container"),
    "an unmeasured container must say so instead of scoring a signal",
  );

  // An empty result set states its absence rather than rendering empty tables.
  const empty = render(dashboard.FinopsKubecostAreaContent, {
    report: envelope({
      resultCount: 0,
      rows: [],
      hourlyCosts: [],
      byAccount: [],
      topClusters: [],
      executiveSummary: { totals: [], componentCosts: [], efficiencies: [] },
      pivots: { namespaces: [], controllers: [], workloads: [], nodes: [] },
    }),
    area: definition.documentedAreas[0],
  });
  assert.ok(empty.includes("No account or cluster evidence"));
  assert.ok(empty.includes("No windowed allocation evidence"));
  assert.ok(empty.includes("Not available"));
  assert.equal(/USD 0\.00/u.test(empty), false, "an absent total must never render as zero");
});

test("a withheld efficiency percentage explains itself", () => {
  const report = envelope();
  const withheld = {
    ...report,
    executiveSummary: {
      ...report.executiveSummary,
      efficiencies: report.executiveSummary.efficiencies.map((item) => (
        item.metric === "RAM" ? { ...item, ratio: null, state: "UNAVAILABLE", contributingGroupCount: 0 } : item
      )),
    },
  };
  const html = render(dashboard.FinopsKubecostAreaContent, {
    report: withheld, area: definition.documentedAreas[0],
  });
  assert.ok(html.includes("Not measured — no request/usage pair in the accepted export"));
  assert.ok(
    html.includes("An efficiency percentage is withheld when the accepted export publishes no request or"),
    "the withholding rule must be explained",
  );
  // The measured CPU ratio is exact: 51/153 core-hours reduces to 1/3.
  assert.ok(html.includes("no terminating decimal"), "a non-terminating ratio stays a fraction");
});

test("EKS breakdown presents node capacity and instance sizing as unavailable", () => {
  const html = render(dashboard.FinopsKubecostAreaContent, {
    report: envelope(), area: definition.documentedAreas[2],
  });
  assert.ok(html.includes("Capacity type breakdown"));
  assert.ok(html.includes("Instance type breakdown"));
  assert.ok(html.includes("Node capacity and instance dimensions"));
  assert.ok(html.includes("Node allocatable capacity is not published"));
  assert.ok(html.includes("Instance-level sizing is not published"));
  assert.ok(
    html.includes("Pod distribution and pod coverage counts are unavailable"),
    "group counts must not be presented as pod counts",
  );
  assert.ok(
    html.includes("never infers capacity type, architecture, node group or instance type"),
    "dimensions must never be inferred",
  );
  // The group whose node dimensions are absent is bucketed as unpublished, with its cost intact.
  assert.ok(html.includes("Dimension not published by the export"));
});

test("reconciliation compares exact rationals with exact CUR2 micro-units", () => {
  const html = render(dashboard.FinopsKubecostAllocationSheets, { report: envelope() });
  assert.ok(html.includes("Reconciliation, provenance, coverage, and history"));
  assert.ok(html.includes("USD 33.00"), "the exact CUR2 micro-unit total must be printed");
  assert.ok(html.includes("attribution view only do not add to cur2"));
  // A currency with no CUR2 total is unavailable, not matched.
  assert.ok(html.includes("EUR"));
  assert.equal((html.match(/Unknown/gu) ?? []).length >= 1, true);
});

test("OpenCost evidence stays labelled as supplemental, not equivalent to Kubecost", () => {
  const kubecost = render(dashboard.FinopsKubecostAllocationSheets, { report: envelope() });
  assert.ok(kubecost.includes("Official self-hosted Kubecost export"));
  assert.equal(kubecost.includes("Supplemental OpenCost evidence."), false);

  const report = envelope();
  const opencost = render(dashboard.FinopsKubecostAllocationSheets, {
    report: { ...report, source: { ...report.source, provider: "OPENCOST" } },
  });
  assert.ok(opencost.includes("Supplemental OpenCost evidence."));
  assert.ok(opencost.includes(definition.supplementalOpenCost.disclosure));
  assert.ok(
    opencost.includes("never counted as official AWS Kubecost dashboard coverage"),
    "OpenCost must never be presented as official dashboard coverage",
  );
});

test("page-scoped derivations disclose that they are page-scoped", () => {
  const report = envelope();
  const paged = {
    ...report,
    rows: report.rows.slice(0, 2),
    resultCount: 6,
    nextCursor: "v1:2",
  };
  const html = render(dashboard.FinopsKubecostAreaContent, {
    report: paged, area: definition.documentedAreas[1],
  });
  assert.ok(html.includes("page-scoped figure, not the full filter scope"));
  assert.ok(html.includes("4 further matching groups are not on this page"));
  assert.ok(html.includes("v1:2"));
});

test("the container preserves its exported name and unavailable state", () => {
  assert.equal(typeof dashboard.FinopsKubecostAllocationDashboard, "function");
  assert.equal(typeof dashboard.FinopsKubecostAllocationReportView, "function");
  assert.equal(typeof dashboard.FinopsKubecostAllocationSheets, "function");
  const html = render(dashboard.FinopsKubecostAllocationDashboard, { connectionId: null });
  assert.match(html, /Unavailable\..*Connect an active AWS trust-role account/u);
  assert.match(html, /Official Kubecost source audit/u);
  // The filter chrome and the tabbed view render together for a loaded report.
  const loaded = render(dashboard.FinopsKubecostAllocationReportView, {
    report: envelope(), filters: {}, onFiltersChange: () => undefined,
  });
  assert.ok(loaded.includes("Capacity type"));
  assert.ok(loaded.includes("Instance type"));
  assert.ok(loaded.includes("Executive Summary"));
  assert.ok(loaded.includes("Allocation, not additional spend."));
});
