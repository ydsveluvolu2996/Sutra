import assert from "node:assert/strict";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const cost = {
  basis: "amortized",
  totalMicros: "1000000",
  coverage: "complete",
};
const ranking = (dimension, value) => ({
  rank: 1,
  dimension,
  value,
  label: value,
  currency: "USD",
  selectedTotalMicros: "1000000",
});

test("native CUDOS overview renders the exact official sheet inventory", async () => {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    server: { middlewareMode: true },
  });
  try {
    const [panel, definition] = await Promise.all([
      vite.ssrLoadModule("/app/costs/finops-foundational-panels.tsx"),
      vite.ssrLoadModule("/lib/finops-cudos-official-definition.ts"),
    ]);
    const auditHtml = renderToStaticMarkup(createElement(
      panel.CudosOfficialEvidence,
      { definition: definition.FINOPS_CUDOS_OFFICIAL_DEFINITION },
    ));
    for (const expected of [
      "Report-independent official AWS CUDOS definition",
      "Official CUDOS v5 source audit",
      "19 sheets · 409 visuals · 142 controls",
      "This source audit remains visible without a billing report",
      "19 official sheets and native evidence gaps",
    ]) assert.match(auditHtml, new RegExp(expected, "iu"), expected);
    assert.doesNotMatch(auditHtml, /sample spend|placeholder spend|mock spend/iu);
    const envelope = {
      connectionId: `conn_${"a".repeat(32)}`,
      selectedPeriod: "2026-07",
      availablePeriods: [],
      sourceState: "complete",
      sourceEvidence: null,
      officialDefinition: definition.FINOPS_CUDOS_OFFICIAL_DEFINITION,
      report: {
        ok: true,
        schema: "sutra.finops-cudos.v1",
        selectedCostBasis: "amortized",
        evidence: { currencies: ["USD"] },
        executive: [{
          currency: "USD",
          costs: [cost],
          accountCount: 2,
          serviceCount: 3,
          chargeKinds: [{ chargeKind: "usage", lineCount: 2, costs: [cost] }],
        }],
        trends: {
          monthly: [{ period: "2026-07", currency: "USD", costs: [cost] }],
          weekly: [{ period: "2026-W27", currency: "USD", costs: [cost] }],
          daily: [{ period: "2026-07-01", currency: "USD", costs: [cost] }],
        },
        rankings: {
          services: [ranking("service", "Amazon EC2")],
          serviceCategories: [ranking("service_category", "Compute")],
        },
      },
    };
    const html = renderToStaticMarkup(createElement(
      panel.CudosOverview,
      { envelope },
    ));
    for (const expected of [
      "19 sheets · 409 visuals · 142 controls",
      "Executive: Billing Summary",
      "Executive: RI/SP Summary",
      "Executive: Trends",
      "Compute",
      "Storage &amp; Backup",
      "Amazon S3",
      "Databases",
      "Amazon DynamoDB",
      "AI/ML",
      "Data Transfer &amp; Networking",
      "Messaging and Streaming",
      "Monitoring &amp; Observability",
      "Analytics",
      "Security",
      "End User Computing",
      "GameTech &amp; Media",
      "Taxonomy Explorer",
      "OPTICS Explorer",
      "About",
      "Monthly CUDOS billing trend",
      "Signed charge-kind disclosure",
    ]) assert.match(html, new RegExp(expected, "iu"), expected);
    assert.doesNotMatch(html, /fixture|placeholder|sample data/iu);
  } finally {
    await vite.close();
  }
});
