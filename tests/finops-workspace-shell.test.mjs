import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const [browser, css] = await Promise.all([
  readFile(path.join(root, "app/costs/costs-browser.tsx"), "utf8"),
  readFile(path.join(root, "app/costs/costs.module.css"), "utf8"),
]);

test("FinOps workspace exposes the complete enterprise information architecture", () => {
  const sections = [
    "overview",
    "explorer",
    "allocation",
    "optimization",
    "commitments",
    "budgets",
    "containers",
    "services",
    "marketplace",
    "sustainability",
    "operations",
    "sources",
  ];
  for (const section of sections) {
    assert.match(browser, new RegExp(`key: "${section}"`, "u"));
  }
  assert.match(browser, /<nav className=\{styles\.workspaceNav\} aria-label="FinOps sections">/u);
  assert.match(browser, /aria-current=\{activeSection === section\.key \? "page" : undefined\}/u);
  assert.match(browser, /#finops-\$\{section\}/u);
  assert.match(css, /\.workspaceNav \{[^}]*flex-wrap: wrap;/u);
  assert.match(
    css,
    /@media screen and \(max-width: 860px\)[\s\S]*\.workspaceNav \{ flex-wrap: nowrap; overscroll-behavior-x: contain; \}/u,
  );
  assert.match(css, /\.workspaceNav button \{[^}]*min-height: 40px;/u);
  assert.match(
    css,
    /@media \(max-width: 720px\) \{[^\n]*\.workspaceNav button \{ min-height: 44px; \}/u,
  );
});

test("workspace preserves existing live capabilities behind explicit sections", () => {
  assert.match(browser, /activeSection === "explorer"[\s\S]*<VisibilityPanels/u);
  assert.match(browser, /activeSection === "explorer"[\s\S]*<FinopsPanels/u);
  assert.match(browser, /activeSection === "allocation"[\s\S]*<FinopsMorePanels/u);
  assert.match(browser, /activeSection === "commitments"[\s\S]*<FinopsCommitmentsPanels/u);
  assert.match(browser, /activeSection === "budgets"[\s\S]*<FinopsWave3Panels/u);
  assert.match(browser, /activeSection === "services"[\s\S]*<FinopsAiGpuPanel/u);
  assert.match(browser, /activeSection === "optimization"[\s\S]*<FinopsSchedulePanel/u);
});

test("source-dependent sections disclose the evidence boundary without demo results", () => {
  assert.match(browser, /Sutra will not display inferred, sample, or placeholder results here/u);
  assert.match(browser, /authoritative AWS source is connected, validated, tenant-scoped, and reconciled/u);
  assert.doesNotMatch(browser, /sampleSpend|demoSpend|fixtureSpend/u);
});

test("billing trust copy matches the split read-only/provisioning/action role architecture", () => {
  assert.match(
    browser,
    /permanent collector reads Cost Explorer metadata and only the customer-owned billing export prefix configured for this connection/u,
  );
  assert.match(
    browser,
    /Export provisioning and every write or remediation action remain in separate, approval-controlled roles/u,
  );
  assert.doesNotMatch(
    browser,
    /requests only Cost Explorer usage and forecast APIs/u,
  );
});
