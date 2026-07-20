import assert from "node:assert/strict";
import test from "node:test";
import { buildPatchPostureInputs } from "../lib/patch-posture-inputs.ts";
import type { JsonValue, PilotResource } from "../lib/pilot-types.ts";

function resource(overrides: Partial<PilotResource> & { resourceType: string; nativeId: string }): PilotResource {
  return {
    resourceKey: `key:${overrides.resourceType}:${overrides.nativeId}`,
    service: "ec2",
    arn: null,
    name: null,
    region: "us-east-1",
    state: "running",
    tags: {},
    configuration: {},
    source: { api: "test", accountId: "123456789012", collectedAt: "2026-07-15T00:00:00.000Z" },
    contentSha256: "sha",
    ...overrides,
  };
}

function patchStateResource(instanceId: string, config: Readonly<Record<string, JsonValue>>): PilotResource {
  return resource({
    service: "ssm",
    resourceType: "aws.ssm.patch-state",
    nativeId: instanceId,
    configuration: { instanceId, managed: true, patchStateAvailable: true, ...config },
  });
}

test("joins an EC2 instance to its SSM patch-state facts by instance id", () => {
  const input = buildPatchPostureInputs({
    resources: [
      resource({
        resourceType: "aws.ec2.instance",
        nativeId: "i-1",
        name: "web-01",
        configuration: { instanceType: "t3.medium", platformDetails: "Linux/UNIX", architecture: "x86_64" },
      }),
      patchStateResource("i-1", {
        baselineId: "pb-9",
        lastScanAt: "2026-07-15T04:15:00.000Z",
        installedCount: 120,
        missingCount: 5,
        failedCount: 1,
        criticalMissingCount: 2,
        securityMissingCount: 3,
        missingPatches: [
          { title: "kernel", kbId: "USN-1", classification: "Security", severity: "Critical" },
        ],
      }),
    ],
  });
  assert.equal(input.instances.length, 1);
  const instance = input.instances[0];
  assert.equal(instance.instanceId, "i-1");
  assert.equal(instance.name, "web-01");
  assert.equal(instance.platform, "Linux/UNIX");
  assert.ok(instance.patch !== null);
  assert.equal(instance.patch?.managed, true);
  assert.equal(instance.patch?.patchStateAvailable, true);
  assert.equal(instance.patch?.missingCount, 5);
  assert.equal(instance.patch?.criticalMissingCount, 2);
  assert.equal(instance.patch?.baselineId, "pb-9");
  assert.equal(instance.patch?.missingPatches.length, 1);
  assert.equal(instance.patch?.missingPatches[0].severity, "Critical");
});

test("an instance with no collected patch-state resource has null patch facts (unmanaged)", () => {
  const input = buildPatchPostureInputs({
    resources: [
      resource({ resourceType: "aws.ec2.instance", nativeId: "i-lonely", configuration: {} }),
    ],
  });
  assert.equal(input.instances.length, 1);
  assert.equal(input.instances[0].patch, null);
});

test("a managed-but-unscanned patch-state joins with patchStateAvailable false", () => {
  const input = buildPatchPostureInputs({
    resources: [
      resource({ resourceType: "aws.ec2.instance", nativeId: "i-2", configuration: {} }),
      patchStateResource("i-2", { patchStateAvailable: false }),
    ],
  });
  const patch = input.instances[0].patch;
  assert.ok(patch !== null);
  assert.equal(patch?.managed, true);
  assert.equal(patch?.patchStateAvailable, false);
  // Counts absent from the facts are surfaced as null, never fabricated as 0.
  assert.equal(patch?.missingCount, null);
});

test("malformed missing-patch entries and non-numeric counts are dropped, never coerced", () => {
  const input = buildPatchPostureInputs({
    resources: [
      resource({ resourceType: "aws.ec2.instance", nativeId: "i-3", configuration: {} }),
      patchStateResource("i-3", {
        missingCount: "not-a-number" as unknown as JsonValue,
        criticalMissingCount: 4,
        missingPatches: [
          "garbage" as unknown as JsonValue,
          { title: "real", kbId: null, classification: "Security", severity: "Important" },
        ],
      }),
    ],
  });
  const patch = input.instances[0].patch;
  assert.ok(patch !== null);
  assert.equal(patch?.missingCount, null);
  assert.equal(patch?.criticalMissingCount, 4);
  assert.equal(patch?.missingPatches.length, 1);
  assert.equal(patch?.missingPatches[0].title, "real");
  assert.equal(patch?.missingPatches[0].kbId, null);
});

test("resources of other types are ignored", () => {
  const input = buildPatchPostureInputs({
    resources: [
      resource({ resourceType: "aws.s3.bucket", nativeId: "bucket-1" }),
      resource({ resourceType: "aws.rds.db-instance", nativeId: "db-1" }),
    ],
  });
  assert.equal(input.instances.length, 0);
});
