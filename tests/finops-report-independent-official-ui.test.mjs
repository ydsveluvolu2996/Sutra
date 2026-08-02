import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const catalogEntry = {
  slug: "official-evidence-test",
  name: "Official evidence test",
  summary: "Frozen source evidence",
  level: "ADVANCED",
  provider: "AWS",
  currentMaturity: "PARTIAL_PIPELINE",
};

test("ADV-01, ADV-02, ADV-04 and ADV-06 render official evidence with no report", async () => {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    server: { middlewareMode: true },
  });
  try {
    const [trustedAdvisor, computeOptimizer, extendedSupport, healthEvents, definitions] = await Promise.all([
      vite.ssrLoadModule("/app/costs/finops-trusted-advisor-organizational-dashboard.tsx"),
      vite.ssrLoadModule("/app/costs/finops-compute-optimizer-dashboard.tsx"),
      vite.ssrLoadModule("/app/costs/finops-extended-support-projection-dashboard.tsx"),
      vite.ssrLoadModule("/app/costs/finops-health-events-dashboard.tsx"),
      Promise.all([
        vite.ssrLoadModule("/lib/finops-trusted-advisor-organizational-official-definition.ts"),
        vite.ssrLoadModule("/lib/finops-compute-optimizer-official-definition.ts"),
        vite.ssrLoadModule("/lib/finops-extended-support-official-definition.ts"),
        vite.ssrLoadModule("/lib/finops-aws-health-official-definition.ts"),
      ]),
    ]);
    const cases = [
      {
        html: renderToStaticMarkup(createElement(
          trustedAdvisor.FinopsTrustedAdvisorOrganizationalDashboard,
          { connectionId: null, dashboard: catalogEntry },
        )),
        expected: ["An active AWS trust-role connection is required", "Official AWS TAO definition coverage", "11 sheets", "147 upstream visuals mapped"],
      },
      {
        html: renderToStaticMarkup(createElement(
          computeOptimizer.FinopsComputeOptimizerDashboard,
          { connectionId: null },
        )),
        expected: ["Connect an active AWS trust-role account", "Official AWS Compute Optimizer Dashboard coverage", "Published Compute Optimizer modules", "Report evidence unavailable"],
      },
      {
        html: renderToStaticMarkup(createElement(
          extendedSupport.FinopsExtendedSupportProjectionDashboard,
          { connectionId: null, dashboard: catalogEntry },
        )),
        expected: ["Connect AWS to configure Extended Support projections", "Official AWS Extended Support coverage", "5 sheets", "60 visuals"],
      },
      {
        html: renderToStaticMarkup(createElement(
          healthEvents.FinopsHealthEventsDashboard,
          { connectionId: null },
        )),
        expected: ["Connect an active AWS trust-role account", "Official AWS Health Events dashboard definition", "3 sheets", "33 visuals"],
      },
    ];
    for (const { html, expected } of cases) {
      for (const text of expected) assert.match(html, new RegExp(text, "u"), text);
    }
    const validatorCases = [
      [trustedAdvisor.hasTrustedAdvisorOfficialDefinition, definitions[0].TRUSTED_ADVISOR_ORGANIZATIONAL_OFFICIAL_DEFINITION, "sourceCommit"],
      [computeOptimizer.hasComputeOptimizerOfficialDefinition, definitions[1].FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION, "source.commit"],
      [extendedSupport.hasExtendedSupportOfficialDefinition, definitions[2].EXTENDED_SUPPORT_OFFICIAL_DEFINITION, "source.commit"],
      [healthEvents.hasHealthEventsOfficialDefinition, definitions[3].FINOPS_AWS_HEALTH_OFFICIAL_DEFINITION, "source.commit"],
    ];
    for (const [validate, definition, mutation] of validatorCases) {
      assert.equal(validate(definition), true);
      const altered = structuredClone(definition);
      if (mutation === "sourceCommit") altered.sourceCommit = "0".repeat(40);
      else altered.source.commit = "0".repeat(40);
      assert.equal(validate(altered), false);
    }
  } finally {
    await vite.close();
  }
});

test("configuration responses retain the validated audit for the non-report UI", async () => {
  const sources = await Promise.all([
    "finops-trusted-advisor-organizational-dashboard.tsx",
    "finops-compute-optimizer-dashboard.tsx",
    "finops-extended-support-projection-dashboard.tsx",
    "finops-health-events-dashboard.tsx",
  ].map((name) => readFile(path.join(root, "app/costs", name), "utf8")));
  for (const source of sources) {
    assert.match(source, /officialDefinition/u);
    assert.match(source, /OfficialDefinitionPanel/u);
  }
  assert.match(sources[0], /envelope\?\.officialDefinition/u);
  assert.match(sources[1], /dashboard === null[\s\S]*officialDefinition: value\.officialDefinition/u);
  assert.match(sources[2], /dashboard === null[\s\S]*officialDefinition: x\.officialDefinition/u);
  assert.match(sources[3], /dashboard === null[\s\S]*officialDefinition: value\.officialDefinition/u);
});
