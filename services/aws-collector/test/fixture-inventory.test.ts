import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  buildFixtureSnapshot,
  snapshotHashInput,
} from "../src/fixture-inventory.js";
import type { RegisteredAwsConnection } from "../src/local-registry.js";

const CONNECTION: RegisteredAwsConnection = {
  tenantId: "org_local_sutra",
  connectionId: "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  expectedAccountId: "123456789012",
  partition: "aws",
  roleArn: "arn:aws:iam::123456789012:role/mspcmdb/SutraReadOnlyRole",
  externalId: "sutra_external_id_1234567890abcd",
  status: "ACTIVE",
  permissionPackVersion: "live-demo-2026-07.3",
  sessionNamePrefix: "sutra-",
  enabledRegions: ["us-east-1", "ap-south-1"],
  createdAt: "2026-07-15T09:00:00.000Z",
  updatedAt: "2026-07-15T09:30:00.000Z",
};

test("fixture produces a complete, relationship-safe one-account snapshot", () => {
  const snapshot = buildFixtureSnapshot({
    jobId: "sync_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    connection: CONNECTION,
    now: new Date("2026-07-15T10:00:00.000Z"),
  });
  assert.equal(snapshot.schemaVersion, "sutra.inventory.v1");
  assert.equal(snapshot.accountId, "123456789012");
  assert.equal(snapshot.coverageState, "complete");
  assert.equal(snapshot.resources.length, 13);
  assert.equal(snapshot.relationships.length, 9);
  assert.equal(snapshot.findings.length, 11);
  assert.ok(snapshot.coverage.every((item) => item.status === "succeeded"));
  assert.equal(
    snapshot.coverage.some((item) => item.collectorKey === "s3.buckets" && item.region === "global"),
    false,
  );
  assert.deepEqual(
    snapshot.coverage
      .filter((item) => item.collectorKey === "s3.buckets")
      .map((item) => ({ region: item.region, itemsObserved: item.itemsObserved })),
    [
      { region: "us-east-1", itemsObserved: 1 },
      { region: "ap-south-1", itemsObserved: 0 },
    ],
  );

  const resourceKeys = new Set(snapshot.resources.map((resource) => resource.resourceKey));
  assert.equal(resourceKeys.size, snapshot.resources.length);
  for (const relationship of snapshot.relationships) {
    assert.ok(resourceKeys.has(relationship.fromResourceKey));
    assert.ok(resourceKeys.has(relationship.toResourceKey));
  }
  for (const finding of snapshot.findings) {
    assert.ok(finding.resourceKey === null || resourceKeys.has(finding.resourceKey));
  }

  const { snapshotSha256, ...unsigned } = snapshot;
  assert.equal(
    snapshotSha256,
    createHash("sha256").update(snapshotHashInput(unsigned), "utf8").digest("hex"),
  );
  assert.equal(JSON.stringify(snapshot).includes(CONNECTION.externalId), false);
});

test("fixture hash binds the job and normalized content", () => {
  const first = buildFixtureSnapshot({
    jobId: "sync_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    connection: CONNECTION,
    now: new Date("2026-07-15T10:00:00.000Z"),
  });
  const second = buildFixtureSnapshot({
    jobId: "sync_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    connection: CONNECTION,
    now: new Date("2026-07-15T10:00:00.000Z"),
  });
  assert.notEqual(first.snapshotSha256, second.snapshotSha256);
});

test("fixture hash is stable across recursively reordered persisted JSON", () => {
  const snapshot = buildFixtureSnapshot({
    jobId: "sync_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    connection: CONNECTION,
    now: new Date("2026-07-15T10:00:00.000Z"),
  });
  const unsigned = Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => key !== "snapshotSha256"),
  ) as Omit<typeof snapshot, "snapshotSha256">;
  const reordered = reverseObjectKeys(unsigned) as typeof unsigned;
  assert.equal(snapshotHashInput(unsigned), snapshotHashInput(reordered));
});

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reverseObjectKeys(item)]),
  );
}
