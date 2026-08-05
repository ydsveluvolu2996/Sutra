import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

/**
 * Chain invariants for the standard-2026-08 permission-pack successors.
 *
 * Packs .1, .2 and .3 each have their own dedicated suite. From .9 onward the
 * packs were added without one, so the properties that make the chain safe were
 * never asserted anywhere: that each successor preserves its predecessor, that
 * the explicit deny ceiling never loses an entry, and above all that every
 * granted action appears in that ceiling.
 *
 * The last one is the load-bearing check. `DenyUnimplementedActions` is an
 * explicit Deny with NotAction at Resource '*', and an explicit deny overrides
 * every allow, so an action granted by a policy but missing from the ceiling is
 * silently dead: the customer deploys the stack, the role looks correct, and the
 * collection returns AccessDenied for a permission the template appears to grant.
 */

const root = resolve(import.meta.dirname, "..");
const ACTION = /^\s+- ([a-z0-9-]+:[A-Za-z0-9*]+)\s*$/u;

/** Statements as `{ sid, effect, actions }`, scanned without a YAML dependency. */
function statements(source) {
  const parsed = [];
  let current = null;
  let collecting = false;
  for (const line of source.split("\n")) {
    const sid = /^\s+- Sid: (\S+)\s*$/u.exec(line);
    if (sid !== null) {
      current = { sid: sid[1], effect: null, actions: [] };
      parsed.push(current);
      collecting = false;
      continue;
    }
    if (current === null) continue;
    const effect = /^\s+Effect: (Allow|Deny)\s*$/u.exec(line);
    if (effect !== null) {
      current.effect = effect[1];
      continue;
    }
    if (/^\s+(?:Not)?Action:\s*$/u.test(line)) {
      collecting = true;
      continue;
    }
    const action = ACTION.exec(line);
    if (collecting && action !== null) current.actions.push(action[1]);
    else if (action === null && line.trim() !== "") collecting = false;
  }
  return parsed;
}

function ceilingOf(parsed) {
  const ceiling = parsed.find((statement) => statement.sid === "DenyUnimplementedActions");
  assert.notEqual(ceiling, undefined, "every pack must carry the deny ceiling");
  assert.equal(ceiling.effect, "Deny");
  return new Set(ceiling.actions);
}

/** Granted action -> the Sid that grants it. */
function grantsOf(parsed) {
  const grants = new Map();
  for (const statement of parsed) {
    if (statement.effect !== "Allow") continue;
    for (const action of statement.actions) {
      if (!grants.has(action)) grants.set(action, statement.sid);
    }
  }
  return grants;
}

const ordinals = (await readdir(resolve(root, "infrastructure")))
  .map((name) => /^customer-onboarding-role-standard-2026-08\.(\d+)\.yaml$/u.exec(name)?.[1])
  .filter((value) => value !== undefined)
  .map(Number)
  .sort((left, right) => left - right);

const packs = new Map();
for (const ordinal of ordinals) {
  const source = await readFile(
    resolve(root, `infrastructure/customer-onboarding-role-standard-2026-08.${ordinal}.yaml`),
    "utf8",
  );
  const parsed = statements(source);
  packs.set(ordinal, {
    ordinal,
    version: `standard-2026-08.${ordinal}`,
    source,
    ceiling: ceilingOf(parsed),
    grants: grantsOf(parsed),
  });
}

test("the successor chain is contiguous and reaches .18", () => {
  assert.deepEqual(ordinals, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
});

test("no pack grants an action its own deny ceiling would deny", () => {
  for (const pack of packs.values()) {
    const dead = [...pack.grants]
      .filter(([action]) => !pack.ceiling.has(action))
      .map(([action, sid]) => `${action} (${sid})`);
    assert.deepEqual(dead, [], `${pack.version} grants actions the ceiling denies: ${dead.join(", ")}`);
  }
});

test("each pack states one version in its metadata, tag and output", () => {
  for (const pack of packs.values()) {
    assert.equal(
      /^    Version: (\S+)$/mu.exec(pack.source)?.[1],
      pack.version,
      `${pack.version} metadata version`,
    );
    assert.equal(
      /Key: sutra:permission-pack\s*\n\s*Value: (\S+)/u.exec(pack.source)?.[1],
      pack.version,
      `${pack.version} permission-pack tag`,
    );
    assert.equal(
      /Immutable permission contract attested by this Sutra release\.\s*\n\s*Value: (\S+)/u
        .exec(pack.source)?.[1],
      pack.version,
      `${pack.version} PermissionPackVersion output`,
    );
    // The "preserves every standard-2026-08.N" phrasing became the convention at
    // .5 and holds from there. Packs .1 to .4 describe their inheritance in prose
    // instead, and they are immutable, so the convention is asserted only where it
    // actually applies rather than retroactively invented for them.
    if (pack.ordinal >= 5) {
      assert.match(
        pack.source,
        new RegExp(`preserves every standard-2026-08\\.${pack.ordinal - 1}\\b`, "u"),
        `${pack.version} must state which predecessor it preserves`,
      );
    }
  }
});

test("each successor preserves its predecessor's ceiling and grants", () => {
  for (const ordinal of ordinals.slice(1)) {
    const pack = packs.get(ordinal);
    const previous = packs.get(ordinal - 1);
    const lostCeiling = [...previous.ceiling].filter((action) => !pack.ceiling.has(action)).sort();
    assert.deepEqual(
      lostCeiling,
      [],
      `${pack.version} dropped ceiling entries from ${previous.version}: ${lostCeiling.join(", ")}`,
    );
    const lostGrants = [...previous.grants.keys()].filter((action) => !pack.grants.has(action)).sort();
    assert.deepEqual(
      lostGrants,
      [],
      `${pack.version} dropped grants from ${previous.version}: ${lostGrants.join(", ")}`,
    );
  }
});

test("each successor adds exactly the actions its vertical declares", () => {
  // The exact new grant of every pack from .13 onward. A pack that widens beyond
  // its vertical fails here rather than at a customer's account.
  const EXPECTED_NEW_GRANTS = {
    13: [
      "aws-marketplace:DescribeAgreement",
      "aws-marketplace:GetAgreementEntitlements",
      "aws-marketplace:GetAgreementTerms",
      "aws-marketplace:ListAgreementCharges",
      "aws-marketplace:SearchAgreements",
      "license-manager:GetServiceSettings",
      "license-manager:ListReceivedGrants",
      "license-manager:ListReceivedGrantsForOrganization",
      "license-manager:ListReceivedLicenses",
      "license-manager:ListReceivedLicensesForOrganization",
    ],
    14: [
      "bcm-data-exports:GetExecution",
      "bcm-data-exports:GetExport",
      "bcm-data-exports:ListExecutions",
      "cost-optimization-hub:GetPreferences",
      "cost-optimization-hub:ListEnrollmentStatuses",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:GetObjectAttributes",
      "s3:ListBucket",
    ],
    15: ["sustainability:GetCarbonFootprintSummary"],
    16: ["connect:DescribeInstance", "connect:ListPhoneNumbersV2", "ds:DescribeDirectories"],
    // .17 grants no new action: both Price List reads are already granted for
    // ADV-05 Graviton. It exists so a Pricing Change connection is attested
    // against its own named source contract.
    17: [],
    18: [
      "config:DescribeAggregateComplianceByConfigRules",
      "config:DescribeAggregateComplianceByConformancePacks",
      "config:DescribeConfigRuleEvaluationStatus",
      "config:DescribeConfigRules",
      "config:DescribeConfigurationAggregatorSourcesStatus",
      "config:DescribeConfigurationAggregators",
      "config:DescribeConfigurationRecorderStatus",
      "config:DescribeConfigurationRecorders",
      "config:GetAggregateComplianceDetailsByConfigRule",
      "config:GetAggregateDiscoveredResourceCounts",
      "config:SelectAggregateResourceConfig",
    ],
  };

  for (const [ordinal, expected] of Object.entries(EXPECTED_NEW_GRANTS)) {
    const pack = packs.get(Number(ordinal));
    const previous = packs.get(Number(ordinal) - 1);
    const added = [...pack.grants.keys()].filter((action) => !previous.grants.has(action)).sort();
    assert.deepEqual(added, expected, `${pack.version} new grants`);
  }
});

test("every pack from .13 grants only read-only actions", () => {
  // Verbs that read. A write verb reaching a customer collector role is the one
  // mistake in this chain that cannot be walked back by a code change.
  const READ_ONLY = /:(?:Describe|Get|List|Search|Select|BatchGet|Lookup|View)[A-Z0-9]/u;
  for (const ordinal of ordinals.filter((value) => value >= 13)) {
    const pack = packs.get(ordinal);
    for (const [action, sid] of pack.grants) {
      if (action === "sts:GetCallerIdentity") continue;
      assert.match(action, READ_ONLY, `${pack.version} grants non-read ${action} in ${sid}`);
    }
  }
});

test("the new source contracts are declared and cumulative", () => {
  const CONTRACTS = {
    13: "marketplace-spg-v1",
    14: "cost-optimization-hub-v1",
    15: "sustainability-carbon-v1",
    16: "amazon-connect-telemetry-v1",
    17: "aws-pricing-catalog-v1",
    18: "aws-config-aggregator-v1",
  };
  for (const [ordinal, contract] of Object.entries(CONTRACTS)) {
    const pack = packs.get(Number(ordinal));
    const declared = /^    AdvancedFinopsSources: (.+)$/mu.exec(pack.source)?.[1].split(",")
      .map((value) => value.trim());
    assert.ok(declared.includes(contract), `${pack.version} must declare ${contract}`);
    // Cumulative: a successor never drops a predecessor's contract.
    const previous = /^    AdvancedFinopsSources: (.+)$/mu
      .exec(packs.get(Number(ordinal) - 1).source)?.[1].split(",").map((value) => value.trim());
    for (const inherited of previous) {
      assert.ok(declared.includes(inherited), `${pack.version} dropped contract ${inherited}`);
    }
  }
});

test("no pack grants a wildcard action or a seller-only Marketplace operation", () => {
  for (const pack of packs.values()) {
    for (const [action, sid] of pack.grants) {
      assert.doesNotMatch(action, /\*/u, `${pack.version} grants wildcard ${action} in ${sid}`);
    }
    assert.doesNotMatch(
      pack.source,
      /aws-marketplace:(?:Create|Update|Delete|Start|Cancel|Put)[A-Z]/u,
      `${pack.version} must not reference a Marketplace mutation`,
    );
  }
});

test("every pack is registered with the CloudFormation linter", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const gate = manifest.scripts["lint:cloudformation"];
  for (const ordinal of ordinals) {
    assert.ok(
      gate.includes(`customer-onboarding-role-standard-2026-08.${ordinal}.yaml`),
      `standard-2026-08.${ordinal} is not linted, so a malformed template would ship unnoticed`,
    );
  }
});
