import assert from "node:assert/strict";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");

test("ADD-03 renders exact official coverage without provider billing data", async () => {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    server: { middlewareMode: true },
  });
  try {
    const [dashboard, official] = await Promise.all([
      vite.ssrLoadModule(
        "/app/costs/finops-gcp-cloud-intelligence-dashboard.tsx",
      ),
      vite.ssrLoadModule(
        "/lib/finops-gcp-cloud-intelligence-official-definition.ts",
      ),
    ]);
    const html = renderToStaticMarkup(createElement(
      dashboard.GcpCloudIntelligenceOfficialDefinitionPanel,
      { definition: official.GCP_CLOUD_INTELLIGENCE_OFFICIAL_DEFINITION },
    ));
    assert.match(html, /Official GCP definition coverage/u);
    assert.match(html, /7 sheets · 60 visuals · 54 controls/u);
    assert.match(html, /Summary/u);
    assert.match(html, />27</u);
    assert.match(html, /Compute Engine/u);
    assert.match(html, />19</u);
    assert.match(html, /Big Query/u);
    assert.match(html, /Kubernetes/u);
    assert.match(html, /Published artifacts, exact structure, and remaining gaps/u);
    assert.match(html, /GCP BIGQUERY BILLING EXPORT ADAPTER NOT DEPLOYED/u);
    assert.match(html, /pixel, geometry, query-result, and interaction parity are not claimed/u);
    assert.doesNotMatch(html, /sample spend|placeholder spend|mock billing/iu);
  } finally {
    await vite.close();
  }
});
