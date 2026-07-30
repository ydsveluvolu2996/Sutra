import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const source = await readFile(resolve(import.meta.dirname, "../app/api/v1/dspm/route.ts"), "utf8");

test("DSPM route derives tenant scope server-side and capability-gates both operations", () => {
  assert.match(source, /requireApiSession\(request\)/u);
  assert.match(source, /getConnectionForOrg\(authenticated\.subject\.orgId/u);
  assert.match(source, /assertSessionCapability\(authenticated, capability, connection\.customerId\)/u);
  assert.match(source, /assertSessionCapability\(authenticated, "connection:manage", connection\.customerId\)/u);
  assert.doesNotMatch(source, /body\.(?:orgId|customerId)/u);
});

test("the mutation authenticates before reading a bounded body and requires same origin", () => {
  const post = source.slice(source.indexOf("export async function POST"));
  assert.ok(post.indexOf("assertSameOrigin(request)") < post.indexOf("requireApiSession(request)"));
  assert.ok(post.indexOf("requireApiSession(request)") < post.indexOf("readBoundedJson(request"));
  assert.match(post, /DSPM_MAX_BODY_BYTES/u);
});

test("the read response discloses privacy and automatic-collection readiness", () => {
  assert.match(source, /sensitiveValuesStored: false/u);
  assert.match(source, /automaticAwsMacieCollection: false/u);
  assert.match(source, /DSPM_SCHEMA_VERSION/u);
});
