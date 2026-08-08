import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pins the onboarding capability labels to the permission pack onboarding
 * actually deploys.
 *
 * The UI states, per capability, whether the customer role grants it. That
 * claim is only worth showing if it cannot drift from the template, so every
 * declared action is checked against the pack YAML rather than trusted.
 *
 * The pack is resolved from `AWS_CUSTOMER_ROLE_TEMPLATE_VERSION` instead of
 * hard-coded here, so bumping onboarding to a successor re-verifies each row
 * against the new pack rather than leaving stale claims passing.
 */

async function loadDeployedPack() {
  const contract = await readFile(path.join(root, "lib/aws-template-contract.ts"), "utf8");
  const version = contract.match(
    /AWS_CUSTOMER_ROLE_TEMPLATE_VERSION\s*=\s*"(standard-\d{4}-\d{2}\.\d{1,2})"/u,
  )?.[1];
  assert.ok(version, "AWS_CUSTOMER_ROLE_TEMPLATE_VERSION must be a standard-YYYY-MM.N literal");
  const yaml = await readFile(
    path.join(root, `infrastructure/customer-onboarding-role-${version}.yaml`),
    "utf8",
  );
  return { version, yaml };
}

async function loadCapabilities() {
  const source = await readFile(path.join(root, "lib/aws-onboarding-role-capabilities.ts"), "utf8");
  const entries = [...source.matchAll(
    /id:\s*"([a-z0-9_]+)",[\s\S]*?actions:\s*\[([\s\S]*?)\],\s*granted:\s*(true|false)/gu,
  )];
  assert.ok(entries.length > 0, "the capability list must be declared as data");
  return entries.map(([, id, actionBlock, granted]) => ({
    id,
    granted: granted === "true",
    actions: [...actionBlock.matchAll(/"([a-z0-9-]+:[A-Za-z]+)"/gu)].map(([, action]) => action),
  }));
}

/**
 * Collects the actions the pack actually grants.
 *
 * Matching raw `- action` lines is not enough, and the difference is not
 * academic. `DenyUnimplementedActions` is a `Deny` whose `NotAction` list names
 * every action the role is *permitted to be given*; it grants nothing. A line
 * scan reads that ceiling as a grant, so `s3:GetObject` and
 * `bcm-data-exports:ListExports` -- which appear only there -- looked granted
 * while the deployed role denies them.
 *
 * So the statements are parsed: an action counts only inside an `Action` list on
 * an `Effect: Allow` statement. There is no YAML parser in this repository's
 * dependencies, hence the indentation-aware scan rather than a load-and-walk.
 */
function allowedActions(yaml) {
  const allowed = new Set();
  let effect = null;
  let list = null;

  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/\s+$/u, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    // A new statement resets both, so an Allow above can never leak its effect
    // onto the list of a Deny below it.
    if (/^\s*-\s+Sid:/u.test(line)) {
      effect = null;
      list = null;
      continue;
    }

    const effectMatch = /^\s*-?\s*Effect:\s*(Allow|Deny)\s*$/u.exec(line);
    if (effectMatch) {
      effect = effectMatch[1];
      list = null;
      continue;
    }

    const keyMatch = /^\s*-?\s*(NotAction|Action|Resource|Condition|Principal):\s*(.*)$/u.exec(line);
    if (keyMatch) {
      const [, key, inline] = keyMatch;
      list = key === "Action" || key === "NotAction" ? key : null;
      // `Action: sts:GetCallerIdentity` on one line is as much a grant as a
      // list, and dropping it would understate the pack.
      if (list === "Action" && effect === "Allow" && inline.trim() !== "") {
        allowed.add(inline.trim().replace(/^["']|["']$/gu, ""));
      }
      continue;
    }

    const item = /^\s*-\s+([a-z0-9-]+:[A-Za-z0-9*]+)\s*$/u.exec(line);
    if (item && list === "Action" && effect === "Allow") allowed.add(item[1]);
  }
  return allowed;
}

// An action is granted only as an exact entry. A substring match would let
// `s3:GetObject` be satisfied by `s3:GetObjectAcl`, which is a different grant.
function grants(yaml, action) {
  return allowedActions(yaml).has(action);
}

test("every capability declares at least one action", async () => {
  for (const capability of await loadCapabilities()) {
    assert.ok(capability.actions.length > 0, `${capability.id} declares no actions`);
  }
});

test("a granted capability's actions are all present in the deployed pack", async () => {
  const { version, yaml } = await loadDeployedPack();
  for (const capability of await loadCapabilities()) {
    if (!capability.granted) continue;
    for (const action of capability.actions) {
      assert.ok(
        grants(yaml, action),
        `${capability.id} claims ${action} but ${version} does not grant it`,
      );
    }
  }
});

test("an ungranted capability's actions are all absent from the deployed pack", async () => {
  // The dangerous direction: the pack quietly gains an action while the UI
  // still tells an operator the capability is not collected.
  const { version, yaml } = await loadDeployedPack();
  for (const capability of await loadCapabilities()) {
    if (capability.granted) continue;
    for (const action of capability.actions) {
      assert.ok(
        !grants(yaml, action),
        `${capability.id} is shown as not granted but ${version} grants ${action}`,
      );
    }
  }
});

test("the onboarding pack is a single pinned version, not a per-connection choice", async () => {
  // The UI renders these rows as fixed facts about one pack. If onboarding ever
  // gains a pack selector, that presentation becomes wrong and this test is the
  // place that says so.
  const contract = await readFile(path.join(root, "lib/aws-template-contract.ts"), "utf8");
  assert.equal(
    [...contract.matchAll(/AWS_CUSTOMER_ROLE_TEMPLATE_VERSION\s*=/gu)].length,
    1,
    "onboarding must deploy exactly one permission pack version",
  );
});
