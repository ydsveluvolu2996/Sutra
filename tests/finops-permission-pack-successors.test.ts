import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AWS_HEALTH_RUNTIME_PERMISSION_PACKS,
  AWS_SUPPORT_CASES_RUNTIME_PERMISSION_PACKS,
  EXTENDED_SUPPORT_RUNTIME_PERMISSION_PACKS,
  RESILIENCE_VUE_RUNTIME_PERMISSION_PACKS,
  DCF_RUNTIME_PERMISSION_PACKS,
  END_USER_COMPUTING_RUNTIME_PERMISSION_PACKS,
  isAwsHealthRuntimePermissionPack,
  isAwsSupportCasesRuntimePermissionPack,
  isExtendedSupportRuntimePermissionPack,
  isResilienceVueRuntimePermissionPack,
  isDcfRuntimePermissionPack,
  isEndUserComputingRuntimePermissionPack,
} from "../lib/finops-permission-pack-successors.ts";

const PACKS = [
  "standard-2026-08.6",
  "standard-2026-08.7",
  "standard-2026-08.8",
  "standard-2026-08.9",
  "standard-2026-08.10",
  "standard-2026-08.11",
  "standard-2026-08.12",
] as const;

test(".8.12 explicitly preserves every predecessor runtime capability", () => {
  assert.deepEqual(EXTENDED_SUPPORT_RUNTIME_PERMISSION_PACKS, PACKS);
  assert.deepEqual(AWS_SUPPORT_CASES_RUNTIME_PERMISSION_PACKS, PACKS.slice(1));
  assert.deepEqual(AWS_HEALTH_RUNTIME_PERMISSION_PACKS, PACKS.slice(2));
  assert.deepEqual(RESILIENCE_VUE_RUNTIME_PERMISSION_PACKS, PACKS.slice(3));
  assert.deepEqual(DCF_RUNTIME_PERMISSION_PACKS, PACKS.slice(4));
  assert.deepEqual(END_USER_COMPUTING_RUNTIME_PERMISSION_PACKS,PACKS.slice(5));

  for (const value of PACKS) {
    assert.equal(isExtendedSupportRuntimePermissionPack(value), true);
    assert.equal(isAwsSupportCasesRuntimePermissionPack(value), PACKS.indexOf(value) >= 1);
    assert.equal(isAwsHealthRuntimePermissionPack(value), PACKS.indexOf(value) >= 2);
    assert.equal(isResilienceVueRuntimePermissionPack(value), PACKS.indexOf(value) >= 3);
    assert.equal(isDcfRuntimePermissionPack(value), PACKS.indexOf(value) >= 4);
    assert.equal(isEndUserComputingRuntimePermissionPack(value),PACKS.indexOf(value)>=5);
  }
});

test("runtime capability checks reject fabricated lexical successors", () => {
  const fabricated = [
    "standard-2026-08.010",
    "standard-2026-08.13",
    "standard-2026-08.90",
    "standard-2027-08.10",
    "standard-2026-09.10",
    "attacker",
  ];
  for (const value of fabricated) {
    assert.equal(isExtendedSupportRuntimePermissionPack(value), false);
    assert.equal(isAwsSupportCasesRuntimePermissionPack(value), false);
    assert.equal(isAwsHealthRuntimePermissionPack(value), false);
    assert.equal(isResilienceVueRuntimePermissionPack(value), false);
    assert.equal(isDcfRuntimePermissionPack(value), false);
    assert.equal(isEndUserComputingRuntimePermissionPack(value),false);
  }
});

test("every predecessor repository and route consumes the explicit catalog", async () => {
  const paths = [
    "../db/finops-extended-support-runtime-repository.ts",
    "../db/finops-aws-support-cases-runtime-repository.ts",
    "../db/finops-aws-health-runtime-repository.ts",
    "../db/finops-resilience-vue-runtime-repository.ts",
    "../db/finops-resilience-vue-repository.ts",
    "../db/finops-dcf-runtime-repository.ts",
    "../db/finops-end-user-computing-runtime-context-repository.ts",
    "../app/api/v1/finops/aws-support-cases-radar/route.ts",
    "../app/api/v1/finops/resilience-vue/route.ts",
  ];
  const sources = await Promise.all(paths.map((path) =>
    readFile(new URL(path, import.meta.url), "utf8")));
  for (const source of sources) {
    assert.match(source, /finops-permission-pack-successors/u);
    assert.equal(source.includes('permissionPackVersion >= "standard-2026-08.'), false);
    assert.equal(source.includes("permission_pack_version >= 'standard-2026-08."), false);
  }
});
