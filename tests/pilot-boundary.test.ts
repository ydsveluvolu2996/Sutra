import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeSnapshotSha256,
  parseCollectorHealth,
  parsePilotSnapshot,
} from "../lib/pilot-boundary.ts";
import {
  describeLatestCollection,
  describeLiveSyncFailure,
  describeLiveSyncResult,
  describeTrustHealth,
} from "../lib/live-sync-presentation.ts";
import type {
  PilotConnection,
  PilotSnapshotPayload,
  PilotState,
  PilotSyncRun,
} from "../lib/pilot-types.ts";

async function snapshot(): Promise<PilotSnapshotPayload> {
  const collectedAt = new Date().toISOString();
  const unsigned: Omit<PilotSnapshotPayload, "snapshotSha256"> = {
    schemaVersion: "sutra.inventory.v1",
    jobId: "sync_1234567890abcdef",
    connectionId: "conn_1234567890abcdef1234567890abcdef",
    accountId: "123456789012",
    partition: "aws",
    roleSessionName: "sutra-sync_1234567890abcdef",
    collectedAt,
    coverageState: "complete",
    coverage: [{
      collectorKey: "ec2.instances",
      region: "us-east-1",
      status: "succeeded",
      itemsObserved: 1,
      pagesObserved: 1,
    }],
    resources: [{
      resourceKey: "aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0",
      service: "ec2",
      resourceType: "AWS::EC2::Instance",
      nativeId: "i-0123456789abcdef0",
      arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0",
      name: "sutra-pilot-web",
      region: "us-east-1",
      state: "running",
      tags: { Environment: "pilot" },
      configuration: { publicIpAddress: null, monitoring: false },
      source: { api: "EC2.DescribeInstances", accountId: "123456789012", collectedAt },
      contentSha256: "a".repeat(64),
    }],
    relationships: [],
    findings: [],
  };
  return { ...unsigned, snapshotSha256: await computeSnapshotSha256(unsigned) };
}

const connection: PilotConnection = {
  id: "conn_1234567890abcdef1234567890abcdef",
  customerId: "cust_1234567890abcdef1234567890abcdef",
  customerName: "Pilot Customer",
  sourceKind: "aws_trust_role",
  fixtureId: null,
  fixtureVersion: null,
  partition: "aws",
  awsAccountId: "123456789012",
  roleArn: "arn:aws:iam::123456789012:role/sutra/SutraReadOnlyRole",
  status: "active",
  enabledRegions: ["us-east-1"],
  permissionPackVersion: "aws-pilot-v1",
  lastValidatedAt: "2026-07-16T10:00:00.000Z",
  lastSuccessfulSyncAt: null,
  createdAt: "2026-07-16T09:00:00.000Z",
  updatedAt: "2026-07-16T10:00:00.000Z",
};

function syncRun(
  status: PilotSyncRun["status"],
  coverageState: PilotSyncRun["coverageState"],
): PilotSyncRun {
  return {
    id: "sync_1234567890abcdef1234567890abcdef",
    connectionId: connection.id,
    status,
    coverageState,
    totals: {},
    startedAt: "2026-07-16T10:01:00.000Z",
    finishedAt: "2026-07-16T10:02:00.000Z",
    createdAt: "2026-07-16T10:01:00.000Z",
  };
}

function stateWith(run?: PilotSyncRun, hasActiveSnapshot = false): PilotState {
  return {
    mode: "live",
    connection,
    resources: [],
    relationships: [],
    findings: [],
    coverage: [],
    latestRunCoverage: run ? { syncRunId: run.id, entries: [] } : null,
    syncRuns: run ? [run] : [],
    activeSnapshot: hasActiveSnapshot
      ? {
        id: "snap_1234567890abcdef1234567890abcdef",
        collectedAt: "2026-07-16T09:30:00.000Z",
        coverageState: "complete",
        snapshotSha256: "a".repeat(64),
        origin: { kind: "aws_sandbox", fixtureId: null, fixtureVersion: null },
      }
      : null,
  };
}

describe("collector boundary validation", () => {
  it("validates the collector principal and expected partition", () => {
    const health = parseCollectorHealth({
      ok: true,
      mode: "fixture",
      version: "0.1.0",
      principalArn: "arn:aws:iam::999988887777:role/SutraLocalCollector",
      sourceAccountId: "999988887777",
      message: "Fixture collector ready",
    }, "aws");
    assert.equal(health.principalArn, "arn:aws:iam::999988887777:role/SutraLocalCollector");
    assert.throws(() => parseCollectorHealth({ ...health }, "aws-us-gov"), /failed Sutra validation/u);
  });

  it("accepts an account-bound, hash-valid snapshot", async () => {
    const payload = await snapshot();
    const parsed = await parsePilotSnapshot(payload, {
      jobId: payload.jobId,
      connectionId: payload.connectionId,
      accountId: payload.accountId,
      partition: payload.partition,
    });
    assert.equal(parsed.resources.length, 1);
  });

  it("rejects tampering after the snapshot digest is computed", async () => {
    const payload = await snapshot();
    const tampered = structuredClone(payload) as PilotSnapshotPayload;
    (tampered.resources[0] as { state: string }).state = "stopped";
    await assert.rejects(
      parsePilotSnapshot(tampered, {
        jobId: payload.jobId,
        connectionId: payload.connectionId,
        accountId: payload.accountId,
        partition: payload.partition,
      }),
      /failed Sutra validation/u,
    );
  });

  it("rejects relationships that reference resources outside the snapshot", async () => {
    const payload = await snapshot();
    const unsigned = {
      ...payload,
      relationships: [{
        fromResourceKey: payload.resources[0]?.resourceKey ?? "missing",
        toResourceKey: "aws:ec2:us-east-1:123456789012:vpc/vpc-missing",
        relationType: "member_of",
        evidence: {},
      }],
    };
    const { snapshotSha256: _, ...withoutHash } = unsigned;
    void _;
    const invalidPayload = { ...unsigned, snapshotSha256: await computeSnapshotSha256(withoutHash) };
    await assert.rejects(
      parsePilotSnapshot(invalidPayload, {
        jobId: payload.jobId,
        connectionId: payload.connectionId,
        accountId: payload.accountId,
        partition: payload.partition,
      }),
      /failed Sutra validation/u,
    );
  });
});

describe("live AWS sync presentation", () => {
  it("presents only a persisted complete run as an active publication", () => {
    const state = stateWith(syncRun("succeeded", "complete"), true);
    const result = describeLiveSyncResult(state, state.syncRuns[0]!.id);

    assert.equal(result.kind, "complete");
    assert.match(result.message, /new CMDB projection is active/u);
    assert.equal(describeTrustHealth(connection).label, "Validated");
  });

  it("records partial evidence without claiming that it replaced the CMDB head", () => {
    const withPreviousProjection = stateWith(syncRun("partial", "partial"), true);
    const withNoProjection = stateWith(syncRun("partial", "partial"), false);

    assert.deepEqual(describeLatestCollection(withPreviousProjection), {
      kind: "partial",
      title: "Partial collection recorded",
      message: "Some configured collectors did not complete. The previous complete CMDB projection remains active. Review the run coverage, correct the AWS permission or service issue, and retry inventory.",
    });
    assert.match(
      describeLiveSyncResult(withNoProjection, withNoProjection.syncRuns[0]!.id).message,
      /No authoritative CMDB projection was promoted/u,
    );
  });

  it("keeps trust success distinct when the following inventory request fails", () => {
    const message = describeLiveSyncFailure({
      publicError: "AWS throttled this inventory request; retry after a short delay.",
      trustValidatedThisAttempt: true,
      existingTrustWasActive: false,
      hasActiveSnapshot: true,
    });

    assert.match(message, /^Trust validation passed, but inventory collection failed/u);
    assert.match(message, /previous complete CMDB projection remains active/u);
    assert.match(message, /customer role does not need to be recreated/u);
  });

  it("does not claim publication when the returned run is missing or failed", () => {
    const failedState = stateWith(syncRun("failed", "unknown"), true);
    const inconsistentState = stateWith(syncRun("succeeded", "partial"), true);
    assert.equal(
      describeLiveSyncResult(failedState, failedState.syncRuns[0]!.id).kind,
      "failed",
    );
    assert.equal(
      describeLiveSyncResult(failedState, "sync_missing").kind,
      "unknown",
    );
    assert.equal(
      describeLiveSyncResult(inconsistentState, inconsistentState.syncRuns[0]!.id).kind,
      "unknown",
    );
  });
});
