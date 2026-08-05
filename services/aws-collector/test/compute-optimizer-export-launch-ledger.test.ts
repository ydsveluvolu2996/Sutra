import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../src/canonical-json.js";
import {
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MINIMUM_PROJECTION,
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY,
  runComputeOptimizerExportLaunch,
  type ComputeOptimizerExportLaunchAttempt,
} from "../src/compute-optimizer-export-launcher.js";
import {
  ComputeOptimizerExportLaunchLedgerError,
  HostedComputeOptimizerExportLaunchLedger,
} from "../src/compute-optimizer-export-launch-ledger.js";

const CONNECTION = `conn_${"a".repeat(32)}`;
const TENANT = "org_alpha";
const ACCOUNT = "111122223333";
const REGION = "ap-south-1";
const NOW = Date.parse("2026-08-02T12:00:01.000Z");

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function attempt(): ComputeOptimizerExportLaunchAttempt {
  const scope = { orgId: TENANT, customerId: "customer_alpha", connectionId: CONNECTION };
  const families = Object.keys(COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY)
    .sort() as Array<keyof typeof COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY>;
  const targets = families.map((exportFamily) => {
    const operation = COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY[exportFamily];
    const request = { fileFormat: "Csv" as const, includeMemberAccounts: true as const,
      filters: [] as const,
      fieldsToExport: [...COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MINIMUM_PROJECTION[exportFamily]],
      s3DestinationConfig: { bucket: "sutra-compute-optimizer-ap-south-1",
        keyPrefix: "organization/history" as string | null } };
    const requestSha256 = hash(canonicalJson({ operation, region: REGION, ...request }));
    return { targetId: `coelt_${hash(canonicalJson({ exportFamily, operation,
      region: REGION, requestSha256 }))}`, exportFamily, operation, region: REGION,
      bucket: request.s3DestinationConfig.bucket, optionalPrefix: "organization/history",
      effectivePrefix: `organization/history/compute-optimizer/${ACCOUNT}/`, request, requestSha256 };
  });
  const batch = { schemaVersion: "sutra.compute-optimizer-export-launch-attempt.v1" as const,
    scope, requesterAccountId: ACCOUNT, partition: "aws" as const, region: REGION,
    scheduledWindow: "2026-08-02T00:00:00.000Z", targets };
  const requestBatchId = `coelb_${hash(canonicalJson(batch))}`;
  const content = { ...batch, requestBatchId, sealedAtIso: "2026-08-02T12:00:00.000Z",
    attemptNumber: 1 };
  const contentSha256 = hash(canonicalJson(content));
  return { ...content, launchAttemptId: `coela_${contentSha256}`, contentSha256 };
}

async function execution(value = attempt()) {
  let index = 0;
  return runComputeOptimizerExportLaunch({ attempt: value, now: () => new Date(NOW),
    client: { send: async (command) => {
      index += 1; const jobId = `job-${index}`;
      const key = `${value.targets[index - 1]!.effectivePrefix}${REGION}-2026-08-02T120000Z-${jobId}.csv`;
      return { jobId, s3Destination: { bucket: command.input.s3DestinationConfig?.bucket,
        key, metadataKey: `${key.slice(0, -4)}-metadata.json` } };
    } } });
}

test("terminal replay is byte-identical and never reclaims provider work", async () => {
  const pool = new FakePool();
  const ledger = new HostedComputeOptimizerExportLaunchLedger({ pool: pool as never, leaseMs: 180_000 });
  const sealed = attempt();
  assert.deepEqual(await ledger.prepare(boundary(sealed, NOW)), { state: "PREPARED" });
  const claim = await ledger.claim(boundary(sealed, NOW));
  assert.equal(claim.state, "CLAIMED");
  assert.equal(pool.row?.state, "IN_PROGRESS");
  const completed = await ledger.complete({ ...boundary(sealed, NOW + 1_000),
    claimToken: claim.state === "CLAIMED" ? claim.claimToken : "", execution: await execution(sealed) });
  const replay = await ledger.prepare(boundary(sealed, NOW + 2_000));
  assert.equal(replay.state, "TERMINAL");
  assert.equal(JSON.stringify(replay.state === "TERMINAL" ? replay.execution : null),
    JSON.stringify(completed));
  assert.equal(pool.row?.state, "TERMINAL");
  const substitutedBody = { schemaVersion: completed.schemaVersion,
    requestBatchId: completed.requestBatchId, launchAttemptId: completed.launchAttemptId,
    status: completed.status, startedAtIso: completed.startedAtIso,
    finishedAtIso: "2026-08-02T12:00:01.001Z", outcomes: completed.outcomes };
  const substitutedHash = hash(canonicalJson(substitutedBody));
  await assert.rejects(ledger.complete({ ...boundary(sealed, NOW + 3_000),
    claimToken: claim.state === "CLAIMED" ? claim.claimToken : "",
    execution: { ...substitutedBody, executionId: `coele_${substitutedHash}`,
      contentSha256: substitutedHash } }));
  assert.equal(pool.row?.execution_json, canonicalJson(completed));
});

test("two replicas permit one claim and return a bounded active state to the other", async () => {
  const pool = new FakePool();
  const first = new HostedComputeOptimizerExportLaunchLedger({ pool: pool as never, leaseMs: 180_000 });
  const second = new HostedComputeOptimizerExportLaunchLedger({ pool: pool as never, leaseMs: 180_000 });
  const sealed = attempt();
  await first.prepare(boundary(sealed, NOW));
  const [left, right] = await Promise.all([
    first.claim(boundary(sealed, NOW)), second.claim(boundary(sealed, NOW)),
  ]);
  assert.deepEqual([left.state, right.state].sort(), ["CLAIMED", "IN_PROGRESS"]);
});

test("expired or crashed in-progress work becomes permanently ambiguous", async () => {
  const pool = new FakePool();
  const ledger = new HostedComputeOptimizerExportLaunchLedger({ pool: pool as never, leaseMs: 130_000 });
  const sealed = attempt();
  await ledger.prepare(boundary(sealed, NOW));
  const claim = await ledger.claim(boundary(sealed, NOW));
  assert.equal(claim.state, "CLAIMED");
  assert.deepEqual(await ledger.prepare(boundary(sealed, NOW + 130_001)), { state: "AMBIGUOUS" });
  assert.deepEqual(await ledger.claim(boundary(sealed, NOW + 130_002)), { state: "AMBIGUOUS" });
  await assert.rejects(ledger.complete({ ...boundary(sealed, NOW + 130_003),
    claimToken: claim.state === "CLAIMED" ? claim.claimToken : "", execution: await execution(sealed) }),
  (error: unknown) => error instanceof ComputeOptimizerExportLaunchLedgerError && error.code === "AMBIGUOUS");
});

test("completion after the lease expires commits ambiguity before rejecting the response", async () => {
  const pool = new FakePool();
  const ledger = new HostedComputeOptimizerExportLaunchLedger({ pool: pool as never, leaseMs: 130_000 });
  const sealed = attempt();
  await ledger.prepare(boundary(sealed, NOW));
  const claim = await ledger.claim(boundary(sealed, NOW));
  assert.equal(claim.state, "CLAIMED");
  await assert.rejects(ledger.complete({ ...boundary(sealed, NOW + 130_001),
    claimToken: claim.state === "CLAIMED" ? claim.claimToken : "", execution: await execution(sealed) }),
  (error: unknown) => error instanceof ComputeOptimizerExportLaunchLedgerError && error.code === "AMBIGUOUS");
  assert.equal(pool.row?.state, "AMBIGUOUS");
  assert.deepEqual(await ledger.prepare(boundary(sealed, NOW + 130_002)), { state: "AMBIGUOUS" });
});

test("scope, attempt and execution substitution fail without changing durable state", async () => {
  const pool = new FakePool();
  const ledger = new HostedComputeOptimizerExportLaunchLedger({ pool: pool as never, leaseMs: 180_000 });
  const sealed = attempt();
  await assert.rejects(ledger.prepare({ ...boundary(sealed, NOW), tenantId: "other_org" }));
  const forged = structuredClone(sealed) as unknown as Record<string, unknown>;
  forged.contentSha256 = "0".repeat(64);
  await assert.rejects(ledger.prepare(boundary(forged as never, NOW)));
  await ledger.prepare(boundary(sealed, NOW));
  const claim = await ledger.claim(boundary(sealed, NOW));
  const tampered = structuredClone(await execution(sealed)) as unknown as Record<string, unknown>;
  tampered.status = "PARTIAL";
  await assert.rejects(ledger.complete({ ...boundary(sealed, NOW + 1_000),
    claimToken: claim.state === "CLAIMED" ? claim.claimToken : "", execution: tampered as never }));
  assert.equal(pool.row?.state, "IN_PROGRESS");
});

function boundary(value: ComputeOptimizerExportLaunchAttempt, nowMs: number) {
  return { tenantId: TENANT, connectionId: CONNECTION, attempt: value, nowMs };
}

interface Row {
  tenant_id: string; connection_id: string; launch_attempt_id: string;
  attempt_content_sha256: string; attempt_json: string;
  state: "PREPARED" | "IN_PROGRESS" | "TERMINAL" | "AMBIGUOUS";
  claim_token: string | null; lease_expires_at: string | null;
  execution_json: string | null; execution_sha256: string | null;
}

class FakePool {
  public row: Row | null = null;
  private tail: Promise<void> = Promise.resolve();
  public async connect() {
    let releaseLock: (() => void) | null = null;
    let transactionSnapshot: Row | null = null;
    return { query: async (sql: string, values: readonly unknown[] = []) => {
      if (sql === "BEGIN") {
        const previous = this.tail;
        this.tail = new Promise<void>((resolve) => { releaseLock = resolve; });
        await previous;
        transactionSnapshot = this.row === null ? null : structuredClone(this.row);
        return { rows: [], rowCount: null };
      }
      if (sql === "ROLLBACK") this.row = transactionSnapshot;
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        releaseLock?.(); releaseLock = null; return { rows: [], rowCount: null };
      }
      if (sql.startsWith("INSERT INTO compute_optimizer_export_launch_executions")) {
        if (this.row === null) this.row = { tenant_id: String(values[0]), connection_id: String(values[1]),
          launch_attempt_id: String(values[2]), attempt_content_sha256: String(values[3]),
          attempt_json: String(values[4]), state: "PREPARED", claim_token: null,
          lease_expires_at: null, execution_json: null, execution_sha256: null };
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FOR UPDATE")) return { rows: this.row === null ? [] : [structuredClone(this.row)], rowCount: this.row === null ? 0 : 1 };
      if (sql.includes("SET state='IN_PROGRESS'")) {
        if (this.row?.state !== "PREPARED") return { rows: [], rowCount: 0 };
        this.row.state = "IN_PROGRESS"; this.row.claim_token = String(values[3]);
        // node-postgres returns BIGINT columns as decimal strings by default.
        this.row.lease_expires_at = String(values[4]); return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SET state='TERMINAL'")) {
        if (this.row?.state !== "IN_PROGRESS" || this.row.claim_token !== values[6]) return { rows: [], rowCount: 0 };
        this.row.state = "TERMINAL"; this.row.execution_json = String(values[3]);
        this.row.execution_sha256 = String(values[4]); this.row.claim_token = null;
        this.row.lease_expires_at = null; return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SET state='AMBIGUOUS'")) {
        if (this.row?.state !== "IN_PROGRESS") return { rows: [], rowCount: 0 };
        this.row.state = "AMBIGUOUS"; this.row.claim_token = null;
        this.row.lease_expires_at = null; return { rows: [], rowCount: 1 };
      }
      if (sql.includes("to_regclass")) return { rows: [{ present: true }], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql.slice(0, 40)}`);
    }, release: () => undefined };
  }
  public async query(sql: string) {
    if (sql.includes("to_regclass")) return { rows: [{ present: true }], rowCount: 1 };
    throw new Error("unexpected pool query");
  }
  public async end(): Promise<void> {}
}
