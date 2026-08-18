import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const flow = await readFile(resolve(root, "app/welcome/welcome-flow.tsx"), "utf8");
const goals = await readFile(resolve(root, "lib/onboarding-goals.ts"), "utf8");
const grid = await readFile(resolve(root, "app/onboard/connect-provider-grid.tsx"), "utf8");
const providers = await readFile(resolve(root, "lib/onboarding-providers.ts"), "utf8");

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

test("the connect step is derived-only and hands off to the provider hub", () => {
  // The page never marks connect done itself; it reads derived progress.
  assert.match(flow, /progress\?\.steps\.connect \?/u);
  assert.doesNotMatch(flow, /patchOnboarding\(\{[^}]*connect/u);
  // The provider cards live in one shared hub so the welcome flow and the
  // connect page cannot drift into offering different providers.
  assert.match(flow, /<ConnectProviderGrid heading="Connect your infrastructure to track every asset, everywhere"/u);
});

test("one step is on screen at a time, and the strip's hash selects which", () => {
  for (const step of ["goals", "name", "connect"]) {
    assert.match(flow, new RegExp(`step === "${step}" \\?`, "u"));
  }
  // Workspace managers follow progress or an explicit hash. Customer-scoped
  // users cannot use a hash to enter organization-wide goal/name settings.
  assert.match(flow, /const canManageWorkspace = sessionView\.session\?\.capabilities\.includes\("membership:manage"\) \?\? false/u);
  assert.match(flow, /const step = canManageWorkspace \? requestedStep \?\? firstIncompleteStep\(progress\) : "connect"/u);
  assert.match(flow, /\{canManageWorkspace \? <button className="button button-secondary" onClick=\{\(\) => goToStep\("name"\)\} type="button">Back<\/button> : null\}/u);
  assert.match(flow, /addEventListener\("hashchange", apply\)/u);
});

test("only AWS offers a Connect control, and no card invents an object count", () => {
  // Exactly one provider has a live path, and it is AWS.
  const live = [...providers.matchAll(/connectHref: "([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(live, ["/onboard"]);
  assert.match(providers, /id: "aws",[\s\S]{0,400}connectHref: "\/onboard"/u);
  // Future providers remain modelled but are not rendered as integrations
  // before a collector exists.
  for (const id of ["azure", "gcp", "oracle"]) {
    assert.match(providers, new RegExp(`id: "${id}",[\\s\\S]{0,400}connectHref: null`, "u"));
  }
  assert.equal([...providers.matchAll(/unavailableReason: null/gu)].length, 1);
  // The grid renders a Connect control only on the available branch.
  assert.match(grid, /CLOUD_PROVIDERS\.filter\(\(provider\) =>\s*\n\s*provider\.connectHref !== null/u);
  assert.match(grid, /Search clouds and integrations/u);
  assert.match(grid, /<span aria-hidden="true">\+<\/span> ADD/u);
  assert.doesNotMatch(grid, /Not yet available/u);
  // No borrowed object counts, and no borrowed customer logos either.
  assert.doesNotMatch(providers, /supports over \d/u);
  assert.doesNotMatch(grid, /supports over \d/u);
  for (const source of [grid, providers]) {
    assert.doesNotMatch(source, /Coca-Cola|Salesforce|NASA|Cisco|Charles Schwab|New York Life/u);
  }
});
