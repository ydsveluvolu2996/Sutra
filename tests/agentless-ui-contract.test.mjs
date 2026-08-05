import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const [route, panel, css] = await Promise.all([
  readFile(new URL("app/api/v1/agentless-scans/route.ts", root), "utf8"),
  readFile(new URL("app/agentless-scans/agentless-scans-panel.tsx", root), "utf8"),
  readFile(new URL("app/globals.css", root), "utf8"),
]);

test("default agentless connection selection uses persisted customer authorization", () => {
  assert.match(route, /connections\.find\(\(entry\) =>[\s\S]*authorize\(authenticated\.subject,/u);
  assert.match(route, /connectionId === null \|\| entry\.id === connectionId/u);
  assert.match(route, /capability: "connection:read"[\s\S]*customerId: entry\.customerId/u);
  assert.doesNotMatch(route, /connections\[0\]/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", scoped\.customerId\)/u);
});

test("the agentless workspace can create and review its first plan", () => {
  assert.match(panel, /Create a reviewable scan plan/u);
  assert.match(panel, /fetch\("\/api\/v1\/agentless-scans", \{[\s\S]*method: "POST"/u);
  assert.match(panel, /body: JSON\.stringify\(\{[\s\S]*connectionId,[\s\S]*scanners,/u);
  assert.match(panel, /No AWS resource was created/u);
  assert.match(panel, /readiness\?\.canPlan !== true/u);
  assert.doesNotMatch(panel, /Today this is expected to return 409/u);
  assert.doesNotMatch(panel, /Scanning is not yet executable/u);
});

test("agentless plan inputs reject empty, duplicate, and out-of-bounds execution policy", () => {
  assert.match(route, /maxConcurrentScans < 1[\s\S]*maxConcurrentScans > 64/u);
  assert.match(route, /snapshotTtlHours < 1[\s\S]*snapshotTtlHours > 168/u);
  assert.match(route, /scanners\.length >= 1[\s\S]*scanners\.length <= 4/u);
  assert.match(route, /new Set\(scanners\)\.size === scanners\.length/u);
  assert.match(route, /requiredTagValue !== undefined && requiredTagKey === undefined/u);
  assert.match(panel, /scanners\.length === 0/u);
});

test("the plan form has explicit desktop and mobile control styling", () => {
  assert.match(css, /\.agentless-plan-form \{/u);
  assert.match(css, /\.agentless-plan-option input \{ width: 18px; height: 18px;/u);
  assert.match(css, /\.app-shell \.agentless-plan-fields input,/u);
});
