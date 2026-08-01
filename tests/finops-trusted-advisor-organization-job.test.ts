import assert from "node:assert/strict";
import test from "node:test";
import {
  enqueueTrustedAdvisorAccountCollections,
  enqueueTrustedAdvisorManifestFinalization,
  FINOPS_TA_ACCOUNT_COLLECT_JOB_KIND,
  FINOPS_TA_MANIFEST_FINALIZE_JOB_KIND,
  parseTrustedAdvisorAccountCollectJobPayload,
  parseTrustedAdvisorManifestFinalizeJobPayload,
  TrustedAdvisorOrganizationJobError,
  type TrustedAdvisorOrganizationQueue,
} from "../lib/finops-trusted-advisor-organization-job.ts";
import type { StoredTrustedAdvisorManifest } from "../db/finops-trusted-advisor-organization-repository.ts";

const manifestId = `tam_${"a".repeat(64)}`;
const anchor = `conn_${"1".repeat(32)}`;
const target = `conn_${"2".repeat(32)}`;
const scope = { organizationId: "org_ta", customerId: "customer_ta", connectionId: anchor };
const manifest: StoredTrustedAdvisorManifest = {
  scope,
  manifestId,
  jobId: "job-ta-1",
  taxonomySnapshotId: "taxonomy-1",
  taxonomySha256: "b".repeat(64),
  accountSetSha256: "c".repeat(64),
  expectedAccountCount: 2,
  status: "collecting",
  createdAtIso: "2026-08-01T00:00:00.000Z",
  startedAtIso: "2026-08-01T00:01:00.000Z",
  finalizedAtIso: null,
  accounts: [{
    accountId: "111122223333",
    accountPosition: 0,
    targetConnectionId: target,
    status: "pending",
    accountSnapshotId: null,
    errorCode: null,
  }, {
    accountId: "444455556666",
    accountPosition: 1,
    targetConnectionId: null,
    status: "pending",
    accountSnapshotId: null,
    errorCode: null,
  }],
};

test("TA organization payload parsers accept exact identity-only envelopes", () => {
  assert.deepEqual(parseTrustedAdvisorAccountCollectJobPayload({
    manifestId,
    accountId: "111122223333",
    connectionId: target,
  }), { manifestId, accountId: "111122223333", connectionId: target });
  assert.deepEqual(parseTrustedAdvisorManifestFinalizeJobPayload({
    manifestId,
    connectionId: anchor,
  }), { manifestId, connectionId: anchor });
  for (const payload of [
    { manifestId, accountId: "111122223333", connectionId: target, accounts: [] },
    { manifestId, accountId: "111122223333", connectionId: target, roleArn: "arn:injected" },
    { manifestId, connectionId: anchor, accountIds: ["999999999999"] },
  ]) assert.throws(
    () => "accountId" in payload
      ? parseTrustedAdvisorAccountCollectJobPayload(payload)
      : parseTrustedAdvisorManifestFinalizeJobPayload(payload),
    TrustedAdvisorOrganizationJobError,
  );
});

test("fan-out queues only persisted runnable manifest members and then its anchor finalizer", async () => {
  const calls: Parameters<TrustedAdvisorOrganizationQueue["enqueue"]>[0][] = [];
  const queue: TrustedAdvisorOrganizationQueue = {
    async enqueue(input) {
      calls.push(input);
      return { id: `job_${String(calls.length).repeat(32)}` };
    },
  };
  assert.deepEqual(await enqueueTrustedAdvisorAccountCollections(queue, scope, manifest, 1), [
    `job_${"1".repeat(32)}`,
  ]);
  assert.equal(calls[0]?.kind, FINOPS_TA_ACCOUNT_COLLECT_JOB_KIND);
  assert.deepEqual(calls[0]?.payload, {
    manifestId,
    accountId: "111122223333",
    connectionId: target,
  });
  assert.deepEqual(Object.keys(calls[0]?.payload ?? {}).sort(), [
    "accountId", "connectionId", "manifestId",
  ]);

  assert.equal(await enqueueTrustedAdvisorManifestFinalization(queue, scope, manifest, 2),
    `job_${"2".repeat(32)}`);
  assert.equal(calls[1]?.kind, FINOPS_TA_MANIFEST_FINALIZE_JOB_KIND);
  assert.deepEqual(calls[1]?.payload, { manifestId, connectionId: anchor });
});
