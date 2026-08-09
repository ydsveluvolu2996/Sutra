import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  connectionHealth,
  evidenceSourceLabel,
  portfolioForRuntime,
  snapshotFreshness,
} from "../lib/portfolio-presentation.ts";
import type { PortfolioConnectionSummary, PortfolioState } from "../lib/portfolio-types.ts";

const MEASURED_AT = "2026-07-16T12:00:00.000Z";

function connection(
  overrides: Partial<PortfolioConnectionSummary> = {},
): PortfolioConnectionSummary {
  return {
    id: "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    customerId: "cust_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceKind: "aws_trust_role",
    fixtureId: null,
    fixtureVersion: null,
    awsAccountId: "123456789012",
    partition: "aws",
    status: "active",
    roleArn: "arn:aws:iam::123456789012:role/SutraReadOnlyRole",
    enabledRegions: ["us-east-1"],
    permissionPackVersion: "2026.07",
    lastSuccessfulSyncAt: "2026-07-16T11:00:00.000Z",
    latestSnapshotAt: "2026-07-16T11:00:00.000Z",
    latestSnapshotOrigin: "aws_live",
    resourceCount: 94,
    openFindingCount: 55,
    ...overrides,
  };
}

test("snapshot freshness uses explicit 24-hour and 72-hour boundaries", () => {
  assert.equal(snapshotFreshness("2026-07-15T12:00:00.000Z", MEASURED_AT).state, "fresh");
  assert.equal(snapshotFreshness("2026-07-14T12:00:00.000Z", MEASURED_AT).state, "aging");
  assert.equal(snapshotFreshness("2026-07-13T12:00:00.000Z", MEASURED_AT).state, "aging");
  assert.equal(snapshotFreshness("2026-07-13T11:59:59.000Z", MEASURED_AT).state, "stale");
  assert.equal(snapshotFreshness(null, MEASURED_AT).state, "missing");
});

test("connection health is derived from persisted state and snapshot freshness", () => {
  assert.equal(connectionHealth(connection(), MEASURED_AT).label, "Healthy");
  assert.equal(connectionHealth(connection({ latestSnapshotAt: null }), MEASURED_AT).label, "No baseline");
  assert.equal(connectionHealth(connection({ latestSnapshotAt: "2026-07-12T12:00:00.000Z" }), MEASURED_AT).label, "Stale");
  assert.equal(connectionHealth(connection({ status: "disabled" }), MEASURED_AT).label, "Disabled");
  assert.equal(connectionHealth(connection({ status: "needs_attention" }), MEASURED_AT).label, "Needs attention");
});

test("evidence labels never present fixtures as live AWS data", () => {
  assert.deepEqual(evidenceSourceLabel(connection()), {
    label: "Live AWS",
    detail: "Customer trust role · AWS API evidence",
  });
  assert.deepEqual(evidenceSourceLabel(connection({
    sourceKind: "simulated_fixture",
    fixtureId: "northstar-retail",
    fixtureVersion: "2026.07.1",
    latestSnapshotOrigin: "simulated_fixture",
  })), {
    label: "Simulated fixture",
    detail: "northstar-retail · 2026.07.1",
  });
});

test("hosted portfolios remove fixture-only customers and recompute mixed aggregates", () => {
  const live = connection();
  const fixture = connection({
    id: "conn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sourceKind: "simulated_fixture",
    fixtureId: "northstar-retail",
    fixtureVersion: "2026.07.1",
    latestSnapshotOrigin: "simulated_fixture",
    resourceCount: 900,
    openFindingCount: 80,
  });
  const portfolio: PortfolioState = {
    organizationId: "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    scopeMode: "all_customers",
    measuredAt: MEASURED_AT,
    totals: { customers: 2, connections: 2, resources: 994, openFindings: 135 },
    customers: [
      {
        id: live.customerId,
        slug: "customer-a",
        name: "Customer A",
        status: "active",
        connectionCount: 2,
        resourceCount: 994,
        openFindingCount: 135,
        latestSnapshotAt: fixture.latestSnapshotAt,
        connections: [live, fixture],
      },
      {
        id: "cust_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        slug: "fixture-only",
        name: "Fixture only",
        status: "active",
        connectionCount: 1,
        resourceCount: fixture.resourceCount,
        openFindingCount: fixture.openFindingCount,
        latestSnapshotAt: fixture.latestSnapshotAt,
        connections: [{ ...fixture, customerId: "cust_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
      },
    ],
  };

  const hosted = portfolioForRuntime(portfolio, false);
  assert.deepEqual(hosted.totals, { customers: 1, connections: 1, resources: 94, openFindings: 55 });
  assert.equal(hosted.customers[0]?.connectionCount, 1);
  assert.equal(hosted.customers[0]?.latestSnapshotAt, live.latestSnapshotAt);
  assert.equal(hosted.customers.some((customer) => customer.name === "Fixture only"), false);
  assert.equal(portfolioForRuntime(portfolio, true), portfolio);
});

test("every health label the panel can receive has a filter chip", async () => {
  // Finding: the deployments queue built its chips from health *states* while
  // rows displayed health *labels*, and connectionHealth() maps several labels
  // onto one state -- so a chip reading "Validating" selected rows all reading
  // "Aging", and "Stale"/"No baseline" had no chip at all.
  //
  // The chips now key on the label, which makes this pairing load-bearing: a new
  // label in connectionHealth() must appear in LABEL_ORDER to take its place in
  // the escalation order. The panel appends unlisted labels rather than dropping
  // them, so drift costs ordering rather than reachability -- this keeps the
  // ordering honest anyway.
  const [presentation, panel] = await Promise.all([
    readFile(new URL("../lib/portfolio-presentation.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/customers/deployments-panel.tsx", import.meta.url), "utf8"),
  ]);

  const health = /export function connectionHealth[\s\S]*?\n\}/u.exec(presentation)?.[0];
  assert.ok(health, "connectionHealth must be locatable to enumerate its labels");
  const emitted = [...health.matchAll(/label:\s*"([^"]+)"/gu)].map(([, label]) => label);
  assert.ok(emitted.length > 0, "connectionHealth must emit labels");

  const order = /const LABEL_ORDER = \[([\s\S]*?)\] as const;/u.exec(panel)?.[1];
  assert.ok(order, "the panel must declare LABEL_ORDER as data");
  const listed = new Set([...order.matchAll(/"([^"]+)"/gu)].map(([, label]) => label));

  for (const label of new Set(emitted)) {
    assert.ok(listed.has(label), `connectionHealth emits "${label}" but LABEL_ORDER omits it`);
  }
  // And nothing listed that can never appear -- a chip for an impossible state
  // is the `error` state this panel already shipped once.
  for (const label of listed) {
    assert.ok(emitted.includes(label), `LABEL_ORDER lists "${label}" but connectionHealth never emits it`);
  }
});
