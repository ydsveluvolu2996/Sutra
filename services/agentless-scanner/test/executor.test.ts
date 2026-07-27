import assert from "node:assert/strict";
import test from "node:test";
import { AGENTLESS_TAG_KEY, AgentlessExecutorError, Ec2AgentlessExecutor } from "../src/executor.js";

interface SentCommand { readonly name: string; readonly input: Record<string, unknown> }

/**
 * Fake EC2 client. Records the command name and input so the tests can assert on
 * exactly which AWS calls would be issued and against which account's client —
 * which is the property that matters here, since the whole trust boundary is
 * "which client sends which verb".
 */
function fakeClient(log: SentCommand[], label: string, responses: Record<string, unknown> = {}) {
  return {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      log.push({ name: `${label}:${name}`, input: command.input });
      if (name === "DescribeSnapshotsCommand") {
        return responses["DescribeSnapshotsCommand"] ?? { Snapshots: [{ State: "completed" }] };
      }
      return responses[name] ?? {};
    },
  };
}

function build(log: SentCommand[], over: Record<string, unknown> = {}, responses: Record<string, unknown> = {}) {
  return new Ec2AgentlessExecutor({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    customerClientFor: async () => fakeClient(log, "customer", responses) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scanClientFor: async () => fakeClient(log, "scan", responses) as any,
    scanAccountId: "111122223333",
    scanAvailabilityZone: "ap-south-1a",
    kmsKeyArn: "arn:aws:kms:ap-south-1:111122223333:key/abc",
    worker: { scan: async () => [{ source: "trivy", severity: "high", title: "CVE-2026-1" }] },
    liveValidated: true,
    sleep: async () => {},
    ...over,
  });
}

test("refuses every operation until an operator asserts live validation", async () => {
  const log: SentCommand[] = [];
  const executor = build(log, { liveValidated: false });
  await assert.rejects(
    () => executor.createSnapshot({ volumeId: "vol-0123abcd", region: "ap-south-1", ttlHours: 24 }),
    (error: unknown) => error instanceof AgentlessExecutorError && error.code === "NOT_LIVE_VALIDATED",
  );
  // Nothing reached AWS.
  assert.deepEqual(log, []);
});

test("tags the snapshot AT CREATION, because the IAM grant is conditioned on it", async () => {
  const log: SentCommand[] = [];
  const executor = build(log, {}, { CreateSnapshotCommand: { SnapshotId: "snap-0123abcd" } });
  const result = await executor.createSnapshot({ volumeId: "vol-0123abcd", region: "ap-south-1", ttlHours: 24 });
  assert.equal(result.snapshotId, "snap-0123abcd");
  const create = log.find((entry) => entry.name === "customer:CreateSnapshotCommand");
  assert.ok(create, "CreateSnapshot was not issued against the customer client");
  const specs = create.input["TagSpecifications"] as { Tags: { Key: string; Value: string }[] }[];
  const tags = specs[0]?.Tags ?? [];
  assert.equal(tags.find((tag) => tag.Key === AGENTLESS_TAG_KEY)?.Value, "true");
  // A separate CreateTags call would be too late for aws:RequestTag.
  assert.ok(!log.some((entry) => entry.name.endsWith("CreateTagsCommand")));
});

test("NO method exists that could delete a snapshot in the customer account", () => {
  const executor = build([]);
  // The seam the orchestrator drives is deliberately missing a customer-side
  // delete. If a future refactor reintroduces `deleteSnapshot`, this fails.
  assert.equal((executor as unknown as Record<string, unknown>)["deleteSnapshot"], undefined);
  assert.equal(typeof executor.deleteScanAccountSnapshot, "function");
  assert.equal(typeof executor.deleteVolume, "function");
});

test("deletes act ONLY through the scan-account client, never the customer's", async () => {
  const log: SentCommand[] = [];
  const executor = build(log);
  await executor.deleteVolume({ volumeId: "vol-0123abcd" });
  await executor.deleteScanAccountSnapshot({ snapshotId: "snap-0123abcd" });
  const destructive = log.filter((entry) => /Delete/u.test(entry.name));
  assert.equal(destructive.length, 2);
  assert.ok(destructive.every((entry) => entry.name.startsWith("scan:")), `a delete used the customer client: ${JSON.stringify(destructive)}`);
});

test("copy shares from the customer, copies in the scan account, then revokes the share", async () => {
  const log: SentCommand[] = [];
  const executor = build(log, {}, { CopySnapshotCommand: { SnapshotId: "snap-9999ffff" } });
  const copied = await executor.copySnapshotKms({ snapshotId: "snap-0123abcd", region: "ap-south-1" });
  assert.equal(copied.snapshotId, "snap-9999ffff");
  const order = log.map((entry) => entry.name);
  const share = order.indexOf("customer:ModifySnapshotAttributeCommand");
  const copy = order.indexOf("scan:CopySnapshotCommand");
  assert.ok(share >= 0 && copy > share, `share must precede copy: ${order.join(" -> ")}`);
  // The share is withdrawn once the independent copy exists.
  const shares = log.filter((entry) => entry.name === "customer:ModifySnapshotAttributeCommand");
  assert.equal(shares.length, 2);
  assert.equal(shares[0]?.input["OperationType"], "add");
  assert.equal(shares[1]?.input["OperationType"], "remove");
  // Sharing is pinned to the one scan account.
  assert.deepEqual(shares[0]?.input["UserIds"], ["111122223333"]);
});

test("a failed share-revoke does not fail the scan, because the copy already exists", async () => {
  const log: SentCommand[] = [];
  let modifyCalls = 0;
  const executor = new Ec2AgentlessExecutor({
    customerClientFor: async () => ({
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = command.constructor.name;
        if (name === "ModifySnapshotAttributeCommand") {
          modifyCalls += 1;
          if (modifyCalls === 2) throw new Error("revoke failed");
          return {};
        }
        if (name === "DescribeSnapshotsCommand") return { Snapshots: [{ State: "completed" }] };
        return {};
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scanClientFor: async () => fakeClient(log, "scan", { CopySnapshotCommand: { SnapshotId: "snap-9999ffff" } }) as any,
    scanAccountId: "111122223333",
    scanAvailabilityZone: "ap-south-1a",
    kmsKeyArn: "arn:aws:kms:ap-south-1:111122223333:key/abc",
    worker: { scan: async () => [] },
    liveValidated: true,
    sleep: async () => {},
  });
  const copied = await executor.copySnapshotKms({ snapshotId: "snap-0123abcd", region: "ap-south-1" });
  assert.equal(copied.snapshotId, "snap-9999ffff");
  assert.equal(modifyCalls, 2);
});

test("a snapshot stuck pending times out instead of hanging forever", async () => {
  const log: SentCommand[] = [];
  const executor = build(log, { snapshotReadyTimeoutMs: 1, pollIntervalMs: 1 },
    { DescribeSnapshotsCommand: { Snapshots: [{ State: "pending" }] } });
  await assert.rejects(
    () => executor.waitForSnapshot({ snapshotId: "snap-0123abcd", region: "ap-south-1", customerOwned: true }),
    (error: unknown) => error instanceof AgentlessExecutorError && error.code === "SNAPSHOT_TIMEOUT",
  );
});

test("a snapshot that errors is reported as failed, not retried to timeout", async () => {
  const log: SentCommand[] = [];
  const executor = build(log, {}, { DescribeSnapshotsCommand: { Snapshots: [{ State: "error" }] } });
  await assert.rejects(
    () => executor.waitForSnapshot({ snapshotId: "snap-0123abcd", region: "ap-south-1", customerOwned: true }),
    (error: unknown) => error instanceof AgentlessExecutorError && error.code === "SNAPSHOT_FAILED",
  );
});

test("malformed ids and a non-account scan target are refused before any AWS call", async () => {
  const log: SentCommand[] = [];
  assert.throws(() => build(log, { scanAccountId: "nope" }),
    (error: unknown) => error instanceof AgentlessExecutorError && error.code === "BAD_SCAN_ACCOUNT");
  const executor = build(log);
  await assert.rejects(() => executor.createSnapshot({ volumeId: "not-a-volume", region: "ap-south-1", ttlHours: 1 }),
    (error: unknown) => error instanceof AgentlessExecutorError && error.code === "BAD_INPUT");
  await assert.rejects(() => executor.deleteVolume({ volumeId: "snap-0123abcd" }),
    (error: unknown) => error instanceof AgentlessExecutorError && error.code === "BAD_INPUT");
  assert.deepEqual(log, []);
});

test("a copy without a scan-account key is refused rather than silently unencrypted", async () => {
  const log: SentCommand[] = [];
  const executor = build(log, { kmsKeyArn: null });
  await assert.rejects(
    () => executor.copySnapshotKms({ snapshotId: "snap-0123abcd", region: "ap-south-1" }),
    (error: unknown) => error instanceof AgentlessExecutorError && error.code === "NO_KMS_KEY",
  );
  assert.deepEqual(log, []);
});
