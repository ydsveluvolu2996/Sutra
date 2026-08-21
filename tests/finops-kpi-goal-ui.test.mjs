import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = new URL("..", import.meta.url).pathname;
const vite = await createServer({
  root,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const dashboard = await vite.ssrLoadModule("/app/costs/finops-kpi-sheets-dashboard.tsx");
const sheets = await vite.ssrLoadModule("/app/costs/finops-foundational-sheets.ts");
after(async () => vite.close());

const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const REPORT = {
  ok: true,
  schema: "sutra.finops-kpi.v1",
  scope: {
    organizationId: "org_1",
    customerId: "customer_1",
    connectionId: CONNECTION_ID,
    exportName: "foundational-cur2-export-v1",
    billingPeriod: "2026-07",
    generationId: `fbg_${"b".repeat(64)}`,
  },
  formulaRegistry: [{
    id: "ec2_graviton_share",
    formulaVersion: "1.0.0",
    label: "EC2 Graviton share",
    numeratorDefinition: "Classifiable EC2 Graviton usage.",
    denominatorDefinition: "Classifiable EC2 architecture usage.",
    targetDirection: "higher_is_better",
    authoritativeEvidenceRequired: false,
    curClassification: "candidate_estimate",
  }],
  evidenceWindow: {
    startIso: "2026-07-01T00:00:00.000Z",
    endIso: "2026-08-01T00:00:00.000Z",
    evaluatedAtIso: "2026-08-01T00:00:00.000Z",
    sourceEvidenceId: "aws-data-export:evidence",
    manifestSha256: "c".repeat(64),
  },
  measurements: [{
    kpiId: "ec2_graviton_share",
    formulaVersion: "1.0.0",
    state: "measured",
    findingKind: "candidate_estimate",
    validationRequired: true,
    selectedGoal: {
      id: `fkg_${"1".repeat(32)}`,
      version: 1,
      targetDirection: "higher_is_better",
      targetBasisPoints: 7_500,
      effectiveFromIso: "2026-07-01T00:00:00.000Z",
      effectiveToIso: null,
      actorId: "operator-1",
      auditReference: "change-101",
      rbacDecisionId: "krbac-decision-1",
      rbacEvidenceReference: "session:evidence",
    },
    eligibleLineCount: 10,
    classifiableLineCount: 10,
    unclassifiedLineCount: 0,
    evidenceCompleteness: "complete",
    reasonCodes: [],
    segments: [{
      basis: "usage_quantity",
      currency: "USD",
      usageUnit: "Hrs",
      numerator: "75",
      denominator: "100",
      currentBasisPoints: 7_500,
      ratioRemainder: "0",
      ratioDenominator: "10000",
      goalStatus: "met",
      gapBasisPoints: 0,
      sourceLineIds: ["line-1"],
      sourceLineIdsTruncated: false,
    }],
  }],
  opportunities: [],
  opportunitiesTruncated: false,
  failures: [],
};

test("KPI goal percentage input converts to exact basis points without float rounding", () => {
  assert.equal(dashboard.parseKpiGoalPercent("0"), 0);
  assert.equal(dashboard.parseKpiGoalPercent("0.01"), 1);
  assert.equal(dashboard.parseKpiGoalPercent("75.25"), 7_525);
  assert.equal(dashboard.parseKpiGoalPercent("100.00"), 10_000);
  for (const invalid of ["", "-1", "100.01", "1.234", "NaN", "1e2"]) {
    assert.equal(dashboard.parseKpiGoalPercent(invalid), null, invalid);
  }
});

test("Set KPI Goals renders governed mutation controls while preserving active authorization evidence", () => {
  const html = renderToStaticMarkup(createElement(
    dashboard.FinopsKpiSheetContent,
    {
      connectionId: CONNECTION_ID,
      goalsConfigured: 1,
      report: REPORT,
      sheet: sheets.findSheet(sheets.FINOPS_KPI_SHEETS, "set-kpi-goals"),
    },
  ));
  for (const text of [
    "Governed goal change",
    "Governed KPI",
    "Target percentage",
    "Effective from (local time)",
    "Audit reference",
    "Save immutable version",
    "Loading governed goal history",
    "Goal governance",
    "krbac-decision-1",
    "75.00%",
  ]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /access key|secret key|session token/iu);
  assert.doesNotMatch(html, /deliberately read-only/iu);
});

test("goal mutation client is same-origin, no-store, connection-bound, and never accepts tenant or actor identity", async () => {
  const source = await readFile(
    new URL("../app/costs/finops-kpi-sheets-dashboard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /\/api\/v1\/finops\/kpi-goals/u);
  assert.match(source, /credentials: "same-origin"/u);
  assert.match(source, /cache: "no-store"/u);
  assert.match(source, /method: "POST"/u);
  assert.match(source, /connectionId,[\s\S]*version: nextVersion,[\s\S]*targetBasisPoints/u);
  assert.doesNotMatch(source, /JSON\.stringify\(\{[\s\S]{0,500}(?:organizationId|customerId|actorId|rbacDecision)/u);
  assert.doesNotMatch(source, /localStorage|sessionStorage/u);
  assert.match(
    source,
    /decision\.resource !== \[\s*"finops-kpi",\s*scope\.organizationId,\s*scope\.customerId,\s*expectedConnectionId,\s*goal\.kpiId,\s*\]\.join\(":"\)/u,
  );
  assert.match(source, /history\.status === "failed"/u);
  assert.match(source, /saving is disabled rather than guessing the next version/u);
  assert.match(source, /setLoaded\(null\);\s*setReloadNonce/u);
});

test("goal route maps expected immutable repository outcomes to safe client statuses", async () => {
  const route = await readFile(
    new URL("../app/api/v1/finops/kpi-goals/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /FinopsFoundationalConfigRepositoryError/u);
  assert.match(route, /error\.code === "OVERLAPPING_GOAL"[\s\S]*409,[\s\S]*"CONFLICT"/u);
  assert.match(route, /error\.code === "VERSION_CONFLICT"[\s\S]*409,[\s\S]*"CONFLICT"/u);
  assert.match(route, /error\.code === "SCOPE_NOT_FOUND"[\s\S]*404,[\s\S]*"NOT_FOUND"/u);
  assert.match(route, /400, "INVALID_INPUT"/u);
  assert.match(route, /requireApiSession\(request\)[\s\S]*readBoundedJson\(request, BODY_BYTES\)/u);
  assert.doesNotMatch(route, /body\.(?:orgId|organizationId|customerId|actorId|rbacDecision)/u);
});
