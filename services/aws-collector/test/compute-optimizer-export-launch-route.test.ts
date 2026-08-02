import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { canonicalJson } from "../src/canonical-json.js";
import { createLocalCollectorServer } from "../src/local-server.js";
import {
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MINIMUM_PROJECTION,
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY,
  type ComputeOptimizerExportLaunchAttempt,
  type ComputeOptimizerExportLaunchClient,
  type ComputeOptimizerExportLaunchExecution,
} from "../src/compute-optimizer-export-launcher.js";
import {
  ComputeOptimizerExportLaunchLedgerError,
  type ComputeOptimizerExportLaunchClaimResult,
  type ComputeOptimizerExportLaunchExecutionLedger,
  type ComputeOptimizerExportLaunchPrepareResult,
} from "../src/compute-optimizer-export-launch-ledger.js";
import type { RegisteredAwsConnection } from "../src/local-registry.js";
import type { ConnectionScope, OnboardingTrustVerification, StoredAwsConnection,
  ValidatedRoleSession } from "../src/types.js";

const TENANT = "org_alpha"; const CONNECTION = `conn_${"a".repeat(32)}`;
const ACCOUNT = "111122223333"; const REGION = "ap-south-1";
const BUCKET = "sutra-compute-optimizer-ap-south-1";
const PATH = `/v1/connections/${CONNECTION}/compute-optimizer-export-launch`;
let clockMs = Date.parse("2026-08-02T12:00:01.000Z");

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function attempt(bucket = BUCKET): ComputeOptimizerExportLaunchAttempt {
  const scope = { orgId: TENANT, customerId: "customer_alpha", connectionId: CONNECTION };
  const targets = (Object.keys(COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY).sort() as
    Array<keyof typeof COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY>).map((exportFamily) => {
      const operation = COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY[exportFamily];
      const request = { fileFormat: "Csv" as const, includeMemberAccounts: true as const,
        filters: [] as const,
        fieldsToExport: [...COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MINIMUM_PROJECTION[exportFamily]],
        s3DestinationConfig: { bucket, keyPrefix: "organization/history" as string | null } };
      const requestSha256 = hash(canonicalJson({ operation, region: REGION, ...request }));
      return { targetId: `coelt_${hash(canonicalJson({ exportFamily, operation,
        region: REGION, requestSha256 }))}`, exportFamily, operation, region: REGION,
        bucket, optionalPrefix: "organization/history",
        effectivePrefix: `organization/history/compute-optimizer/${ACCOUNT}/`, request, requestSha256 };
    });
  const batch = { schemaVersion: "sutra.compute-optimizer-export-launch-attempt.v1" as const,
    scope, requesterAccountId: ACCOUNT, partition: "aws" as const, region: REGION,
    scheduledWindow: "2026-08-02T00:00:00.000Z", targets };
  const requestBatchId = `coelb_${hash(canonicalJson(batch))}`;
  const content = { ...batch, requestBatchId, sealedAtIso: "2026-08-02T12:00:00.000Z", attemptNumber: 1 };
  const contentSha256 = hash(canonicalJson(content));
  return { ...content, launchAttemptId: `coela_${contentSha256}`, contentSha256 };
}

function stored(version: "standard-2026-08.4" | "standard-2026-08.5" = "standard-2026-08.5"):
RegisteredAwsConnection {
  const base = { tenantId: TENANT, connectionId: CONNECTION, expectedAccountId: ACCOUNT,
    partition: "aws" as const, roleArn: `arn:aws:iam::${ACCOUNT}:role/sutra/SutraCollectorRole`,
    externalId: "4a3e789b-5a2e-47db-9cab-226cbe52fc04", status: "ACTIVE" as const,
    permissionPackVersion: version, enabledRegions: [REGION], createdAt: new Date(clockMs).toISOString(),
    updatedAt: new Date(clockMs).toISOString() };
  return version === "standard-2026-08.4" ? base : { ...base,
    computeOptimizerExportLaunchContracts: [{ tenantId: TENANT, connectionId: CONNECTION,
      accountId: ACCOUNT, partition: "aws", region: REGION, contractId: "co-launch-aps1",
      permissionPackVersion: "standard-2026-08.5",
      permissionContractId: "compute-optimizer-export-launch-v1",
      policyName: `SutraComputeOptimizerExportLaunchV1-${REGION}`, bucket: BUCKET,
      bucketArn: `arn:aws:s3:::${BUCKET}`, basePrefix: "organization/history/",
      effectivePrefix: `organization/history/compute-optimizer/${ACCOUNT}/`,
      objectArnPrefix: `arn:aws:s3:::${BUCKET}/organization/history/compute-optimizer/${ACCOUNT}/*`,
      encryptionMode: "SSE_KMS", bucketVersioningStatus: "Enabled",
      kmsKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT}:key/compute-optimizer-key`,
      servicePrincipal: "compute-optimizer.amazonaws.com" }] };
}

class Registry {
  public constructor(public record: RegisteredAwsConnection) {}
  public async resolve(scope: ConnectionScope, id: string): Promise<StoredAwsConnection | null> {
    return scope.tenantId === this.record.tenantId && id === CONNECTION ? this.record : null;
  }
  public async getRegistered(scope: ConnectionScope, id: string): Promise<RegisteredAwsConnection | null> {
    return this.resolve(scope, id) as Promise<RegisteredAwsConnection | null>;
  }
  public async markOnboardingVerified(_a: ConnectionScope, _b: string, _c: OnboardingTrustVerification): Promise<void> { void _a; void _b; void _c; }
  public async upsert(): Promise<void> {} public async disable(): Promise<void> {}
  public async offboard(): Promise<void> {} public async activateOnboarding(): Promise<void> {}
  public async discardStagedOnboarding(): Promise<void> {}
}

class MemoryLedger implements ComputeOptimizerExportLaunchExecutionLedger {
  public state: "EMPTY" | "PREPARED" | "IN_PROGRESS" | "TERMINAL" | "AMBIGUOUS" = "EMPTY";
  public execution: ComputeOptimizerExportLaunchExecution | null = null;
  public failComplete = false; public leaseExpiresAt = 0;
  public async prepare(input: { nowMs: number }): Promise<ComputeOptimizerExportLaunchPrepareResult> {
    if (this.state === "IN_PROGRESS" && input.nowMs > this.leaseExpiresAt) this.state = "AMBIGUOUS";
    if (this.state === "EMPTY") this.state = "PREPARED";
    if (this.state === "TERMINAL") return { state: "TERMINAL", execution: this.execution! };
    return { state: this.state } as ComputeOptimizerExportLaunchPrepareResult;
  }
  public async claim(input: { nowMs: number }): Promise<ComputeOptimizerExportLaunchClaimResult> {
    if (this.state === "PREPARED") { this.state = "IN_PROGRESS";
      this.leaseExpiresAt = input.nowMs + 130_000; return { state: "CLAIMED", claimToken: `coelc_${"a".repeat(36)}` }; }
    if (this.state === "TERMINAL") return { state: "TERMINAL", execution: this.execution! };
    return { state: this.state } as ComputeOptimizerExportLaunchClaimResult;
  }
  public async complete(input: { execution: ComputeOptimizerExportLaunchExecution }): Promise<ComputeOptimizerExportLaunchExecution> {
    if (this.failComplete) throw new ComputeOptimizerExportLaunchLedgerError("STORAGE_FAILED");
    this.execution = structuredClone(input.execution); this.state = "TERMINAL"; return this.execution;
  }
}

const SESSION: ValidatedRoleSession = { connectionId: CONNECTION, accountId: ACCOUNT,
  partition: "aws", roleArn: `arn:aws:iam::${ACCOUNT}:role/sutra/SutraCollectorRole`,
  roleSessionName: "sutra-launch", callerIdentityArn: `arn:aws:sts::${ACCOUNT}:assumed-role/SutraCollectorRole/sutra-launch`,
  expiresAt: new Date("2099-01-01T00:00:00.000Z"), credentials: {
    accessKeyId: "ASIALAUNCH", secretAccessKey: "raw-secret", sessionToken: "raw-token",
    expiration: new Date("2099-01-01T00:00:00.000Z") } };

test("durable terminal replay returns byte-identical execution without another AWS call", async () => {
  clockMs = Date.parse("2026-08-02T12:00:01.000Z");
  const ledger = new MemoryLedger(); let calls = 0; const commands = new Set<string>();
  const runtime = await start(ledger, stored(), { send: async (command) => {
    calls += 1; commands.add(command.constructor.name); const jobId = `job-${calls}`;
    const key = `organization/history/compute-optimizer/${ACCOUNT}/${REGION}-2026-08-02T120000Z-${jobId}.csv`;
    return { jobId, s3Destination: { bucket: BUCKET, key, metadataKey: `${key.slice(0, -4)}-metadata.json` } };
  } });
  try {
    const first = await signed(runtime.url, runtime.secret, attempt());
    const replay = await signed(runtime.url, runtime.secret, attempt());
    assert.equal(first.status, 200); assert.equal(replay.status, 200);
    assert.equal(first.body, replay.body); assert.equal(calls, 8); assert.equal(commands.size, 8);
    assert.doesNotMatch(first.body, /ASIALAUNCH|raw-secret|raw-token/u);
  } finally { await runtime.close(); }
});

test("lost terminal persistence becomes ambiguous after expiry and never relaunches", async () => {
  clockMs = Date.parse("2026-08-02T12:00:01.000Z");
  const ledger = new MemoryLedger(); ledger.failComplete = true; let calls = 0;
  const runtime = await start(ledger, stored(), { send: async (command) => {
    calls += 1; const jobId = `job-${calls}`;
    const key = `organization/history/compute-optimizer/${ACCOUNT}/${REGION}-2026-08-02T120000Z-${jobId}.csv`;
    return { jobId, s3Destination: { bucket: command.input.s3DestinationConfig?.bucket,
      key, metadataKey: `${key.slice(0, -4)}-metadata.json` } };
  } });
  try {
    assert.equal((await signed(runtime.url, runtime.secret, attempt())).status, 503);
    assert.equal(calls, 8); clockMs += 130_001; ledger.failComplete = false;
    const retry = await signed(runtime.url, runtime.secret, attempt());
    assert.equal(retry.status, 409); assert.match(retry.body, /LAUNCH_AMBIGUOUS/u);
    assert.equal(calls, 8);
  } finally { await runtime.close(); }
});

test("an active duplicate returns a bounded conflict without another AWS launch", async () => {
  clockMs = Date.parse("2026-08-02T12:00:01.000Z");
  const ledger = new MemoryLedger();
  ledger.state = "IN_PROGRESS";
  ledger.leaseExpiresAt = clockMs + 130_000;
  let calls = 0;
  const runtime = await start(ledger, stored(), { send: async () => {
    calls += 1;
    throw new Error("must not run");
  } });
  try {
    const duplicate = await signed(runtime.url, runtime.secret, attempt());
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body, /LAUNCH_IN_PROGRESS/u);
    assert.equal(calls, 0);
  } finally { await runtime.close(); }
});

test("route fails closed without ledger and denies .8.4 or destination substitution before AWS", async () => {
  let calls = 0; const client = { send: async () => { calls += 1; throw new Error("must not run"); } };
  for (const fixture of [
    { ledger: undefined, connection: stored(), payload: attempt(), status: 409 },
    { ledger: new MemoryLedger(), connection: stored("standard-2026-08.4"), payload: attempt(), status: 409 },
    { ledger: new MemoryLedger(), connection: stored(), payload: attempt("other-safe-bucket"), status: 400 },
  ]) {
    const runtime = await start(fixture.ledger, fixture.connection, client);
    try { assert.equal((await signed(runtime.url, runtime.secret, fixture.payload)).status, fixture.status); }
    finally { await runtime.close(); }
  }
  assert.equal(calls, 0);
});

test("provider failure is sanitized, persisted PARTIAL, and fail-stops later commands", async () => {
  const ledger = new MemoryLedger(); let calls = 0;
  const runtime = await start(ledger, stored(), { send: async () => {
    calls += 1; throw Object.assign(new Error("customer secret raw provider message"), { name: "AccessDeniedException" });
  } });
  try {
    const result = await signed(runtime.url, runtime.secret, attempt());
    assert.equal(result.status, 200); assert.match(result.body, /"status":"PARTIAL"/u);
    assert.match(result.body, /ACCESS_DENIED/u);
    assert.doesNotMatch(result.body, /customer secret|raw provider/u); assert.equal(calls, 1);
  } finally { await runtime.close(); }
});

async function start(
  ledger: ComputeOptimizerExportLaunchExecutionLedger | undefined,
  connection: RegisteredAwsConnection,
  client: ComputeOptimizerExportLaunchClient,
) {
  const secret = randomBytes(32).toString("base64url"); const registry = new Registry(connection);
  const server = createLocalCollectorServer({ sharedSecret: secret, registry, mode: "live",
    allowLiveAws: true, principalArn: "arn:aws:iam::999988887777:role/SutraCollectorWorkload",
    now: () => new Date(clockMs), ...(ledger === undefined ? {} : { computeOptimizerExportLaunchLedger: ledger }),
    computeOptimizerExportLaunchRoleBrokerFactory: () => ({
      assumeValidatedComputeOptimizerExportLaunchSession: async () => SESSION,
    }), computeOptimizerExportLaunchClientFactory: () => client });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { secret, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function signed(base: string, secret: string, payload: unknown) {
  const body = JSON.stringify(payload); const timestamp = clockMs.toString();
  const nonce = `nonce_${randomBytes(18).toString("base64url")}`;
  const signature = hmac(secret, `POST\n${PATH}\n${timestamp}\n${nonce}\n${hash(body)}`);
  const response = await fetch(`${base}${PATH}`, { method: "POST", headers: {
    "content-type": "application/json", "x-sutra-timestamp": timestamp,
    "x-sutra-nonce": nonce, "x-sutra-signature": signature }, body });
  const responseBody = await response.text();
  assert.equal(response.headers.get("x-sutra-response-signature"),
    hmac(secret, `${response.status}\n${PATH}\n${nonce}\n${hash(responseBody)}`));
  return { status: response.status, body: responseBody };
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64url")).update(value).digest("hex");
}
