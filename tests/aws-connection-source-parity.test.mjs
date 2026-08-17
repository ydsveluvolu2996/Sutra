import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

// Access-key onboarding (`aws_static_credentials`) shipped as a first-class
// connection method, but the customer-scoped read routes still gated on
// `sourceKind !== "aws_trust_role"`. That gate predates static credentials: its
// error text ("Simulation connections use the simulation controls") shows it was
// written to exclude simulated fixtures, not to exclude a second real AWS
// credential kind. Left as-is it let a customer finish onboarding and then get a
// 404 from every dashboard, and blocked them from disabling or offboarding the
// connection they had just made. These tests lock the widened boundary and, more
// importantly, lock the part that must not widen: a simulated fixture is still
// never readable as collected customer evidence.

const source = await readFile(
  new URL("../lib/aws-connection-source.ts", import.meta.url),
  "utf8",
);

test("exactly the two real AWS credential kinds are collectable", () => {
  const list = /AWS_COLLECTABLE_SOURCE_KINDS = Object\.freeze\(\[([\s\S]*?)\] as const\)/u
    .exec(source);
  assert.ok(list !== null, "the allowlist must be an exact frozen enumeration");
  const kinds = [...list[1].matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(kinds, ["aws_trust_role", "aws_static_credentials"]);
});

test("the predicate is an exact membership test, never a prefix or regex match", () => {
  assert.match(source, /\.includes\(sourceKind\)/u);
  assert.doesNotMatch(source, /startsWith|endsWith|RegExp|test\(sourceKind\)|\.match\(/u);
});

test("simulated fixtures are never collectable", () => {
  const list = /AWS_COLLECTABLE_SOURCE_KINDS = Object\.freeze\(\[([\s\S]*?)\] as const\)/u
    .exec(source);
  assert.ok(list !== null);
  assert.doesNotMatch(list[1], /simulated_fixture/u);
});

async function routeFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  }));
  return found.flat();
}

test("no customer-scoped route still pins the pre-static-credentials gate", async () => {
  const routes = await routeFiles(new URL("../app/api", import.meta.url).pathname);
  assert.ok(routes.length > 100, "the route sweep must actually find the API surface");
  const offenders = [];
  for (const path of routes) {
    const body = await readFile(path, "utf8");
    if (/sourceKind !== "aws_trust_role"/u.test(body)) offenders.push(path);
  }
  assert.deepEqual(offenders, []);
});

test("the lifecycle routes accept static-credential connections", async () => {
  for (const route of ["disable", "offboard"]) {
    const body = await readFile(
      new URL(`../app/api/pilot/connections/${route}/route.ts`, import.meta.url),
      "utf8",
    );
    assert.match(body, /!isCollectableAwsSourceKind\(current\.sourceKind\)/u);
  }
});

test("static-credential offboarding always requires recent MFA", async () => {
  // Disable retains the customer secret reference, so a disabled static
  // connection is not offboarded. Only the trust-role idempotency case may
  // bypass a second step-up check after its role ARN has already been cleared.
  const body = await readFile(
    new URL("../app/api/pilot/connections/offboard/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    body,
    /alreadyOffboarded = current\.status === "disabled"\s*\n?\s*&& current\.sourceKind === "aws_trust_role"\s*\n?\s*&& current\.roleArn === null/u,
  );
  assert.match(body, /if \(!alreadyOffboarded\) requireRecentMfa\(actor\.authenticated\)/u);
});

test("role-only paths that must not widen are still role-only", async () => {
  // These are not oversights. The hosted broker fails closed on static
  // credentials until a reviewed hosted at-rest contract exists, and role
  // validation commits `VerifiedRoleEvidence`, which a key connection has no
  // equivalent of; it uses commitVerifiedConnectionCredentials instead.
  const hosted = await readFile(
    new URL("../lib/hosted-broker-ingest-job.ts", import.meta.url),
    "utf8",
  );
  assert.match(hosted, /sourceKind !== "aws_trust_role"/u);
  const repository = await readFile(
    new URL("../db/pilot-repository.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    repository,
    /connection\.sourceKind !== "aws_trust_role" \|\| connection\.roleArn === null/u,
  );
});
