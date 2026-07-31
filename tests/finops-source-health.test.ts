import assert from "node:assert/strict";
import test from "node:test";
import {
  FINOPS_CAPABILITY_DEFINITIONS,
  FINOPS_SOURCE_DEFINITIONS,
  buildFinopsSourceReadiness,
  type FinopsSourceEvidence,
  type FinopsSourceId,
  type FinopsSourceScope,
} from "../lib/finops-source-health.ts";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const scope: FinopsSourceScope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

function evidence(
  sourceId: FinopsSourceId,
  overrides: Partial<FinopsSourceEvidence> = {},
): FinopsSourceEvidence {
  return {
    scope,
    sourceId,
    configured: true,
    deliveryObserved: true,
    lastAttemptAt: "2026-07-31T10:00:00.000Z",
    lastAttemptOutcome: "succeeded",
    lastSuccessAt: "2026-07-31T10:00:00.000Z",
    dataThroughAt: "2026-07-31T10:00:00.000Z",
    coverage: {
      assessment: "complete",
      acceptedRecords: 100,
      expectedRecords: 100,
      rejectedRecords: 0,
    },
    lastError: null,
    evidenceBasis: "Test evidence",
    ...overrides,
  };
}

function stateFor(sourceId: FinopsSourceId, sourceEvidence: FinopsSourceEvidence): string {
  return buildFinopsSourceReadiness({ scope, evidence: [sourceEvidence], nowMs: NOW })
    .sources.find((source) => source.id === sourceId)?.state ?? "missing";
}

test("catalog models exactly 27 AWS-relevant capabilities across all three levels", () => {
  assert.equal(FINOPS_CAPABILITY_DEFINITIONS.length, 27);
  assert.equal(FINOPS_CAPABILITY_DEFINITIONS.filter((entry) => entry.level === "foundational").length, 3);
  assert.equal(FINOPS_CAPABILITY_DEFINITIONS.filter((entry) => entry.level === "advanced").length, 13);
  assert.equal(FINOPS_CAPABILITY_DEFINITIONS.filter((entry) => entry.level === "additional").length, 11);
  assert.equal(new Set(FINOPS_CAPABILITY_DEFINITIONS.map((entry) => entry.id)).size, 27);
  assert.equal(new Set(FINOPS_SOURCE_DEFINITIONS.map((entry) => entry.id)).size, FINOPS_SOURCE_DEFINITIONS.length);
  assert.ok(FINOPS_CAPABILITY_DEFINITIONS.every((entry) =>
    entry.documentationUrl.startsWith("https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/")
  ));
});

test("absence of scoped evidence is never promoted to configured or healthy", () => {
  const report = buildFinopsSourceReadiness({ scope, evidence: [], nowMs: NOW });
  assert.equal(report.summary.totalCapabilities, 27);
  assert.equal(report.summary.readyCapabilities, 0);
  assert.equal(report.summary.sources.not_configured, FINOPS_SOURCE_DEFINITIONS.length);
  assert.equal(report.summary.capabilities.not_configured, 27);
  assert.ok(report.sources.every((source) =>
    source.state === "not_configured"
    && source.lastError === null
    && source.evidenceBasis === null
  ));
});

test("source state machine distinguishes waiting, healthy, stale, partial, and failed", () => {
  assert.equal(stateFor("aws_cur2_data_export", evidence("aws_cur2_data_export", {
    deliveryObserved: false,
    lastAttemptAt: null,
    lastAttemptOutcome: null,
    lastSuccessAt: null,
    dataThroughAt: null,
    coverage: { assessment: "unknown", acceptedRecords: null, expectedRecords: null, rejectedRecords: 0 },
  })), "waiting_first_delivery");

  assert.equal(stateFor("aws_cur2_data_export", evidence("aws_cur2_data_export")), "healthy");

  assert.equal(stateFor("aws_cur2_data_export", evidence("aws_cur2_data_export", {
    lastSuccessAt: "2026-07-27T10:00:00.000Z",
    dataThroughAt: "2026-07-27T10:00:00.000Z",
  })), "stale");

  assert.equal(stateFor("aws_cur2_data_export", evidence("aws_cur2_data_export", {
    coverage: { assessment: "partial", acceptedRecords: 80, expectedRecords: 100, rejectedRecords: 20 },
  })), "partial");

  assert.equal(stateFor("aws_cur2_data_export", evidence("aws_cur2_data_export", {
    lastAttemptAt: "2026-07-31T11:00:00.000Z",
    lastAttemptOutcome: "failed",
    lastError: {
      code: "EXPORT_FAILED",
      message: "The latest export failed.",
      at: "2026-07-31T11:00:00.000Z",
    },
  })), "failed");
});

test("future timestamps and unknown completeness cannot produce healthy status", () => {
  const report = buildFinopsSourceReadiness({
    scope,
    nowMs: NOW,
    evidence: [evidence("aws_cur2_data_export", {
      dataThroughAt: "2026-08-01T12:00:00.000Z",
    })],
  });
  const source = report.sources.find((entry) => entry.id === "aws_cur2_data_export");
  assert.equal(source?.state, "partial");
  assert.equal(source?.freshness.fresh, null);
  assert.match(source?.limitations.join(" ") ?? "", /future/u);

  assert.equal(stateFor("aws_cur2_data_export", evidence("aws_cur2_data_export", {
    coverage: { assessment: "unknown", acceptedRecords: 100, expectedRecords: null, rejectedRecords: 0 },
  })), "partial");
});

test("engine ignores evidence from another org, customer, or connection", () => {
  const foreignEvidence = evidence("aws_cur2_data_export", {
    scope: {
      orgId: "org_alpha",
      customerId: "customer_bravo",
      connectionId: scope.connectionId,
    },
  });
  const report = buildFinopsSourceReadiness({ scope, evidence: [foreignEvidence], nowMs: NOW });
  const source = report.sources.find((entry) => entry.id === "aws_cur2_data_export");
  assert.equal(source?.state, "not_configured");
  assert.equal(report.summary.readyCapabilities, 0);
});

test("canonical source health drives readiness while supplemental rows only establish partial evidence", () => {
  const supplementalOnly = buildFinopsSourceReadiness({
    scope,
    nowMs: NOW,
    evidence: [evidence("sutra_billing_workspace", {
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastAttemptOutcome: "unknown",
      coverage: { assessment: "unknown", acceptedRecords: 100, expectedRecords: null, rejectedRecords: 0 },
    })],
  });
  for (const capabilityId of ["cudos", "cost_intelligence_dashboard", "kpi_dashboard", "trends", "data_transfer"]) {
    const capability = supplementalOnly.capabilities.find((entry) => entry.id === capabilityId);
    assert.equal(capability?.state, "partial");
    assert.equal(capability?.ready, false);
    assert.deepEqual(capability?.blockingSourceIds, ["aws_cur2_data_export"]);
  }

  const canonical = buildFinopsSourceReadiness({
    scope,
    nowMs: NOW,
    evidence: [evidence("aws_cur2_data_export")],
  });
  assert.equal(canonical.capabilities.find((entry) => entry.id === "cudos")?.state, "healthy");
  assert.equal(canonical.capabilities.find((entry) => entry.id === "pricing_change")?.state, "partial");
});

test("collection monitor is ready only from healthy scoped collection telemetry", () => {
  const report = buildFinopsSourceReadiness({
    scope,
    nowMs: NOW,
    evidence: [evidence("data_collection_telemetry")],
  });
  const monitor = report.capabilities.find((entry) => entry.id === "data_collection_monitor");
  assert.equal(monitor?.state, "healthy");
  assert.equal(monitor?.ready, true);
  assert.deepEqual(monitor?.blockingSourceIds, []);
  assert.equal(report.capabilities.find((entry) => entry.id === "compute_optimizer")?.state, "partial");
});
