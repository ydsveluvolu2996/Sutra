import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateSbomComponentPolicy,
  normalizeSbomComponentPolicy,
  SbomComponentPolicyError,
} from "../lib/kubernetes-sbom-component-policy.ts";

function component(over: { fingerprint?: string; name: string; version?: string | null; packageUrl?: string | null }) {
  return { fingerprint: "a".repeat(64), version: null, packageUrl: null, ...over };
}

test("normalizes a valid policy and rejects extra keys or malformed entries", () => {
  const policy = normalizeSbomComponentPolicy({
    name: "hardening-baseline",
    requirePackageUrl: true,
    bannedComponents: [{ name: "log4j-core", version: "2.14.1", packageUrl: null }, { name: "leftpad" }],
  });
  assert.equal(policy.bannedComponents.length, 2);
  assert.throws(() => normalizeSbomComponentPolicy({ name: "x", requirePackageUrl: true, bannedComponents: [], extra: 1 }), SbomComponentPolicyError);
  assert.throws(() => normalizeSbomComponentPolicy({ name: "x", requirePackageUrl: "yes", bannedComponents: [] }), SbomComponentPolicyError);
});

test("a name-only ban blocks every version; a version-scoped ban blocks only that version", () => {
  const policy = normalizeSbomComponentPolicy({
    name: "bans", requirePackageUrl: false,
    bannedComponents: [{ name: "log4j-core", version: "2.14.1", packageUrl: null }, { name: "flatmap-stream" }],
  });
  const evaluation = evaluateSbomComponentPolicy(policy, [
    component({ name: "log4j-core", version: "2.14.1" }), // banned (version match)
    component({ name: "log4j-core", version: "2.17.1" }), // allowed (different version)
    component({ name: "flatmap-stream", version: "0.1.1" }), // banned (name-only)
    component({ name: "openssl", version: "3.0.1" }), // allowed
  ]);
  assert.equal(evaluation.status, "fail");
  assert.equal(evaluation.violations.length, 2);
  assert.equal(evaluation.compliantComponents, 2);
  const log4j = evaluation.violations.find((v) => v.componentName === "log4j-core");
  assert.equal(log4j?.reason, "BANNED_COMPONENT");
  assert.equal(log4j?.matchedRule, "log4j-core@2.14.1");
});

test("requirePackageUrl fails components with no provenance", () => {
  const policy = normalizeSbomComponentPolicy({ name: "purl", requirePackageUrl: true, bannedComponents: [] });
  const evaluation = evaluateSbomComponentPolicy(policy, [
    component({ name: "identified", packageUrl: "pkg:npm/identified@1.0" }),
    component({ name: "mystery", packageUrl: null }),
  ]);
  assert.equal(evaluation.status, "fail");
  assert.equal(evaluation.violations.length, 1);
  assert.equal(evaluation.violations[0]?.reason, "MISSING_PACKAGE_URL");
});

test("a clean inventory passes and cites nothing", () => {
  const policy = normalizeSbomComponentPolicy({ name: "clean", requirePackageUrl: false, bannedComponents: [{ name: "banned" }] });
  const evaluation = evaluateSbomComponentPolicy(policy, [component({ name: "openssl", packageUrl: "pkg:apk/openssl" })]);
  assert.equal(evaluation.status, "pass");
  assert.deepEqual(evaluation.violations, []);
  assert.equal(evaluation.claimBoundary, "OBSERVED_SBOM_COMPONENT_METADATA_ONLY");
});

test("truncation past the limit is reported and forces a non-pass", () => {
  const policy = normalizeSbomComponentPolicy({ name: "limit", requirePackageUrl: false, bannedComponents: [] });
  const components = Array.from({ length: 3 }, (_, index) => component({ name: `c${index}`, packageUrl: `pkg:npm/c${index}` }));
  const evaluation = evaluateSbomComponentPolicy(policy, components, 2);
  assert.equal(evaluation.truncated, true);
  assert.equal(evaluation.componentsEvaluated, 2);
  assert.equal(evaluation.status, "fail");
});
