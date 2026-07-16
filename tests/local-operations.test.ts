import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseLocalFixtureCatalog,
  parseLocalFixtureEnqueue,
  parseLocalFixtureJob,
  parseLocalFixtureJobs,
  type LocalFixtureDescriptor,
} from "../lib/local-ops-types.ts";

const NOW = "2026-07-16T04:00:00.000Z";

function fixture(overrides: Partial<LocalFixtureDescriptor> = {}): LocalFixtureDescriptor {
  return {
    fixtureId: "northstar-retail",
    customerName: "Northstar Retail",
    customerId: `cust_${"a".repeat(32)}`,
    tenantId: "org_local_sutra",
    connectionId: `conn_${"b".repeat(32)}`,
    accountId: "111122223333",
    partition: "aws",
    enabledRegions: ["us-east-1"],
    availableVersions: ["2026.07.0", "2026.07.1"],
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: `job_${"c".repeat(48)}`,
    tenantId: "org_local_sutra",
    kind: "fixture.inventory.collect",
    fixtureId: "northstar-retail",
    customerId: `cust_${"a".repeat(32)}`,
    connectionId: `conn_${"b".repeat(32)}`,
    version: "2026.07.0",
    status: "pending",
    attempts: 0,
    maxAttempts: 5,
    availableAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    lastFailure: null,
    ...overrides,
  };
}

describe("signed local operations boundary", () => {
  it("accepts an exact, unique fixture catalog", () => {
    const parsed = parseLocalFixtureCatalog({ fixtures: [fixture()] });
    assert.equal(parsed[0]?.customerName, "Northstar Retail");
    assert.throws(() => parseLocalFixtureCatalog({ fixtures: [fixture(), fixture()] }), /invalid/u);
  });

  it("rejects impossible durable job states", () => {
    assert.equal(parseLocalFixtureJob(job()).status, "pending");
    assert.throws(() => parseLocalFixtureJob(job({ maxAttempts: 0 })), /invalid/u);
    assert.throws(() => parseLocalFixtureJob(job({ attempts: 6 })), /invalid/u);
    assert.throws(() => parseLocalFixtureJob(job({ status: "succeeded", completedAt: null })), /invalid/u);
    assert.throws(() => parseLocalFixtureJob(job({
      status: "dead_letter",
      completedAt: NOW,
      lastFailure: null,
    })), /invalid/u);
  });

  it("binds an enqueue response to the signed fixture scope", () => {
    const signedFixture = fixture();
    const accepted = parseLocalFixtureEnqueue(
      { created: true, job: job() },
      signedFixture,
      "2026.07.0",
    );
    assert.equal(accepted.job.connectionId, signedFixture.connectionId);
    assert.throws(() => parseLocalFixtureEnqueue(
      { created: true, job: job({ tenantId: "org_other" }) },
      signedFixture,
      "2026.07.0",
    ), /invalid/u);
    assert.throws(() => parseLocalFixtureEnqueue(
      { created: true, job: job({ connectionId: `conn_${"d".repeat(32)}` }) },
      signedFixture,
      "2026.07.0",
    ), /invalid/u);
  });

  it("requires the signed job count and positive list limit to match", () => {
    assert.equal(parseLocalFixtureJobs({ jobs: [job()], count: 1, limit: 30 }).length, 1);
    assert.throws(() => parseLocalFixtureJobs({ jobs: [job()], count: 0, limit: 30 }), /invalid/u);
    assert.throws(() => parseLocalFixtureJobs({ jobs: [], count: 0, limit: 0 }), /invalid/u);
  });
});
