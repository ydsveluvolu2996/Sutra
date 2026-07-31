import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const [dashboard, routing, governance, docs, kubernetesSections] = await Promise.all([
  readFile(new URL("app/dashboard/page.tsx", root), "utf8"),
  readFile(new URL("app/cases/routing/routing-workspace.tsx", root), "utf8"),
  readFile(new URL("lib/governance-policy-engine.ts", root), "utf8"),
  readFile(new URL("app/docs/page.tsx", root), "utf8"),
  readFile(new URL("app/kubernetes/kubernetes-sections.ts", root), "utf8"),
]);

test("case-routing surfaces describe preview behavior and never claim automatic assignment", () => {
  assert.match(dashboard, /Preview tenant-scoped assignment and ITSM routing decisions/u);
  assert.doesNotMatch(dashboard, /Automatic case assignment/u);
  assert.match(routing, /TRIAGE PLANNING · PREVIEW ONLY/u);
  assert.match(routing, /rules do not mutate those cases/u);
  assert.match(routing, /never change a case[^<]+real assignee or dispatch to an ITSM provider/u);
  assert.doesNotMatch(routing, /Rules apply to open cases|triage automation/iu);
});

test("governance case actions disclose that evaluation proposes but does not execute", () => {
  assert.match(governance, /label: "Sutra proposes opening a case"/u);
  assert.match(governance, /Policy evaluation creates and routes nothing/u);
  assert.match(governance, /case-routing rules are preview-only/u);
  assert.match(governance, /ITSM delivery requires a separate authorized dispatch/u);
  assert.doesNotMatch(governance, /Sutra opens and routes a case/u);
});

test("documentation and Kubernetes section descriptions match their live wiring", () => {
  assert.match(docs, /<AppShell active="docs">/u);
  assert.match(docs, /account menu owns the real Documentation destination and icon/u);
  assert.doesNotMatch(docs, /NavKey is a placeholder/u);
  assert.match(kubernetesSections, /Signed Falco heartbeat and normalized runtime evidence/u);
  assert.doesNotMatch(kubernetesSections, /runtime collection cannot be enabled from this build/u);
  assert.match(kubernetesSections, /applied through customer-controlled GitOps/u);
});
