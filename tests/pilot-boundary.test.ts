import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeSnapshotSha256,
  parseCollectorHealth,
  parsePilotSnapshot,
} from "../lib/pilot-boundary.ts";
import type { PilotSnapshotPayload } from "../lib/pilot-types.ts";

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
