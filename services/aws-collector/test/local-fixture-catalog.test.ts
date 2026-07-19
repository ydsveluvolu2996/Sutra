import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildLocalFixtureEvolution,
  buildLocalFixtureSnapshot,
  createLocalFixtureCollectionJobPayload,
  diffFixtureSnapshots,
  executeLocalFixtureCollectionJob,
  listLocalFixtureAccounts,
  LocalFixtureCatalogError,
} from "../src/local-fixture-catalog.js";

const OBSERVED_AT = new Date("2026-07-15T12:00:00.000Z");

test("catalog exposes three safe accounts using control-plane identifier conventions", () => {
  const accounts = listLocalFixtureAccounts();
  assert.equal(accounts.length, 3);
  assert.equal(new Set(accounts.map((account) => account.accountId)).size, 3);
  assert.equal(new Set(accounts.map((account) => account.customerId)).size, 3);
  assert.equal(new Set(accounts.map((account) => account.connectionId)).size, 3);

  for (const account of accounts) {
    assert.equal(account.tenantId, "org_local_sutra");
    assert.match(account.customerId, /^cust_[a-f0-9]{32}$/);
    assert.match(account.connectionId, /^conn_[a-f0-9]{32}$/);
    assert.match(account.accountId, /^\d{12}$/);
    assert.deepEqual(account.availableVersions, ["2026.07.0", "2026.07.1"]);
    assert.equal(account.enabledRegions.length, 2);
  }

  const serialized = JSON.stringify(accounts);
  assert.equal(serialized.includes("externalId"), false);
  assert.equal(serialized.includes("roleArn"), false);
  assert.equal(serialized.includes("local-fixture-"), false);
});

test("each catalog account executes locally and returns a complete scoped snapshot", () => {
  for (const account of listLocalFixtureAccounts()) {
    const payload = createLocalFixtureCollectionJobPayload(
      account.fixtureId,
      "2026.07.0",
    );
    const result = executeLocalFixtureCollectionJob({
      jobId: `sync_${account.accountId}`,
      tenantId: account.tenantId,
      payload,
      now: OBSERVED_AT,
    });

    assert.equal(result.customerId, account.customerId);
    assert.equal(result.connectionId, account.connectionId);
    assert.equal(result.snapshot.connectionId, account.connectionId);
    assert.equal(result.snapshot.accountId, account.accountId);
    assert.equal(result.snapshot.coverageState, "complete");
    assert.equal(result.snapshot.resources.length, 13);
    assert.deepEqual(
      result.snapshot.coverage
        .filter((entry) => entry.collectorKey === "s3.buckets")
        .map((entry) => entry.region),
      account.enabledRegions,
    );
    assert.ok(
      result.snapshot.resources.every(
        (resource) => resource.source.accountId === account.accountId,
      ),
    );
    assert.equal(JSON.stringify(result).includes("external-id"), false);
  }
});

test("fixture collection execution rejects cross-customer and cross-tenant scope", () => {
  const [first, second] = listLocalFixtureAccounts();
  assert.ok(first);
  assert.ok(second);
  const payload = createLocalFixtureCollectionJobPayload(first.fixtureId, "2026.07.1");

  assert.throws(
    () =>
      executeLocalFixtureCollectionJob({
        jobId: "sync_scope_violation",
        tenantId: "org_wrong_tenant",
        payload,
        now: OBSERVED_AT,
      }),
    LocalFixtureCatalogError,
  );
  assert.throws(
    () =>
      executeLocalFixtureCollectionJob({
        jobId: "sync_scope_violation",
        tenantId: first.tenantId,
        payload: { ...payload, customerId: second.customerId },
        now: OBSERVED_AT,
      }),
    LocalFixtureCatalogError,
  );
});

test("version evolution emits exactly one meaningful add, change, and remove", () => {
  const fixtureId = "northstar-retail";
  const evolution = buildLocalFixtureEvolution({
    fixtureId,
    fromVersion: "2026.07.0",
    toVersion: "2026.07.1",
    now: OBSERVED_AT,
  });

  assert.equal(evolution.events.length, 3);
  assert.deepEqual(
    evolution.events.map((event) => event.kind).sort(),
    ["added", "changed", "removed"],
  );
  const added = evolution.events.find((event) => event.kind === "added");
  const changed = evolution.events.find((event) => event.kind === "changed");
  const removed = evolution.events.find((event) => event.kind === "removed");
  assert.ok(added && added.kind === "added");
  assert.ok(changed && changed.kind === "changed");
  assert.ok(removed && removed.kind === "removed");
  assert.equal(added.after.nativeId, "sutra-audit-evidence-111122223333");
  assert.equal(changed.after.nativeId, "customer-db-1");
  assert.deepEqual(changed.changedFields, ["tags", "configuration"]);
  assert.equal(changed.before.configuration.storageEncrypted, false);
  assert.equal(changed.after.configuration.storageEncrypted, true);
  assert.equal(changed.after.configuration.publiclyAccessible, false);
  assert.equal(removed.before.nativeId, "i-0f9e8d7c6b5a43210");
  assert.equal(new Set(evolution.events.map((event) => event.eventId)).size, 3);
});

test("semantic diff ignores collection time while preserving evolved snapshot integrity", () => {
  const baseline = buildLocalFixtureSnapshot({
    fixtureId: "meridian-health",
    version: "2026.07.0",
    jobId: "sync_baseline",
    now: new Date("2026-07-15T10:00:00.000Z"),
  });
  const sameVersionLater = buildLocalFixtureSnapshot({
    fixtureId: "meridian-health",
    version: "2026.07.0",
    jobId: "sync_later",
    now: new Date("2026-07-16T10:00:00.000Z"),
  });
  const evolvedLater = buildLocalFixtureSnapshot({
    fixtureId: "meridian-health",
    version: "2026.07.1",
    jobId: "sync_evolved",
    now: new Date("2026-07-16T10:00:00.000Z"),
  });

  assert.deepEqual(diffFixtureSnapshots(baseline, sameVersionLater), []);
  assert.equal(diffFixtureSnapshots(baseline, evolvedLater).length, 3);
  const resourceKeys = new Set(evolvedLater.resources.map((resource) => resource.resourceKey));
  assert.ok(
    evolvedLater.relationships.every(
      (relationship) =>
        resourceKeys.has(relationship.fromResourceKey) &&
        resourceKeys.has(relationship.toResourceKey),
    ),
  );
  assert.ok(
    evolvedLater.findings.every(
      (finding) => finding.resourceKey === null || resourceKeys.has(finding.resourceKey),
    ),
  );
  assert.equal(
    evolvedLater.findings.some((finding) => finding.controlKey.includes("RDS")),
    false,
  );
});
