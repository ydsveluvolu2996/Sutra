import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const report = await readFile(
  new URL("../app/reports/executive-report-browser.tsx", import.meta.url),
  "utf8",
);

test("executive report presents Kubernetes evidence without inventing runtime protection", () => {
  assert.match(report, /useKubernetesEvidence\(state\)/u);
  assert.match(report, /03 · Kubernetes assurance/u);
  assert.match(report, /kubernetesWorkspace\.scannerEvidence\.sboms/u);
  assert.match(report, /Kubernetes evidence SHA-256/u);
  assert.match(report, /Runtime detection and admission enforcement are not configured/u);
  assert.match(report, /finding\.severity === "critical" \|\| finding\.severity === "high"/u);
  assert.doesNotMatch(report, /runtime protection is enabled/iu);
});
