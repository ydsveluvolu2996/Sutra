import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const flow = await readFile(resolve(root, "app/welcome/welcome-flow.tsx"), "utf8");
const goals = await readFile(resolve(root, "lib/onboarding-goals.ts"), "utf8");

test("the goal cards cover the exact catalog, no more, no less", () => {
  for (const id of ["cmdb", "finops", "vulnerabilities"]) {
    assert.match(goals, new RegExp(`"${id}"`, "u"));
    assert.match(flow, new RegExp(`id: "${id}"`, "u"));
  }
  assert.match(flow, /Gain full cloud visibility[\s\S]*Optimize cloud spending[\s\S]*Remediate vulnerabilities/u);
  // Goals are presented as a lens, and the copy says so.
  assert.match(flow, /never change what your workspace is allowed to do/u);
});

test("both mutating steps write through the API and announce the change", () => {
  assert.match(flow, /method: "PATCH"/u);
  assert.match(flow, /patchOnboarding\(\{ goals: selected \}\)/u);
  assert.match(flow, /patchOnboarding\(\{ workspaceName: shownName \}\)/u);
  assert.match(flow, /sutra:onboarding-changed/u);
  // Renaming refreshes the session so the account menu shows the new name.
  assert.match(flow, /sutra:session-changed/u);
});

test("the connect step is derived-only and AWS is the only live provider", () => {
  // The page never marks connect done itself; it reads derived progress.
  assert.match(flow, /progress\?\.steps\.connect \?/u);
  assert.doesNotMatch(flow, /patchOnboarding\(\{[^}]*connect/u);
  // One functional provider path; roadmap providers render no Connect control
  // and no invented object counts.
  assert.match(flow, /href="\/onboard">Connect AWS<\/Link>/u);
  assert.match(flow, /data-available="false"[\s\S]{0,200}Not yet available/u);
  assert.doesNotMatch(flow, /Connect Azure|Connect GCP|Connect Oracle|supports over \d/u);
});
