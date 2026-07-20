import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { executeLocalFixtureCollectionJob } from "../src/local-fixture-catalog.js";
import { MemoryLocalJobStateStore } from "../src/local-job-state.js";
import {
  BoundedLiveInventorySink,
  createLocalCollectorServer,
  isPublicSshIngressCandidate,
  LIVE_SNAPSHOT_RESPONSE_BUDGET_BYTES,
  normalizeCollectorCoverage,
  normalizeLiveSnapshot,
} from "../src/local-server.js";
import type { NormalizedAwsEvidence, NormalizedAwsResource } from "../src/types.js";

const NOW = new Date("2026-07-15T10:00:00.000Z");
const TENANT_ID = "org_local_sutra";
const CONNECTION_ID = "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CUSTOMER_ID = "cust_11111111111111111111111111111111";
const MERIDIAN_CUSTOMER_ID = "cust_22222222222222222222222222222222";
const SCHEDULE_ID = `sched_${createHash("sha256")
  .update(`local-fixture-schedule\u0000${TENANT_ID}\u0000northstar-retail`, "utf8")
  .digest("hex")
  .slice(0, 48)}`;
const UPSERT_MUTATION_ID = `schedop_${"a".repeat(48)}`;
const ENABLE_MUTATION_ID = `schedop_${"b".repeat(48)}`;
const DISABLE_MUTATION_ID = `schedop_${"c".repeat(48)}`;
const REENABLE_MUTATION_ID = `schedop_${"d".repeat(48)}`;
const STALE_MUTATION_ID = `schedop_${"e".repeat(48)}`;

function liveEvidence(
  sequence: number,
  evidenceType: "AWS_NATIVE_FINDING" | "CLOUDTRAIL_LOGGING_STATUS",
): NormalizedAwsEvidence {
  return {
    schemaVersion: 1,
    provider: "aws",
    evidenceKey: `aws:123456789012:us-east-1:test:${evidenceType}:${sequence}`,
    accountId: "123456789012",
    region: "us-east-1",
    service: evidenceType === "AWS_NATIVE_FINDING" ? "guardduty" : "cloudtrail",
    evidenceType,
    subjectId: `subject-${sequence}`,
    status: "OBSERVED",
    observedAt: NOW.toISOString(),
    data:
      evidenceType === "AWS_NATIVE_FINDING"
        ? {
            nativeService: "GuardDuty",
            normalizedSeverity: "medium",
            normalizedStatus: "open",
            title: `Finding ${sequence}`,
          }
        : { coverageBasis: "test" },
  };
}

function liveResource(sequence: number, padding = ""): NormalizedAwsResource {
  const resourceId = `node-${sequence.toString().padStart(5, "0")}`;
  return {
    schemaVersion: 1,
    provider: "aws",
    resourceKey: `aws:123456789012:us-east-1:ec2:aws.ec2.instance:${resourceId}`,
    accountId: "123456789012",
    region: "us-east-1",
    service: "ec2",
    resourceType: "aws.ec2.instance",
    resourceId,
    arn: `arn:aws:ec2:us-east-1:123456789012:instance/${resourceId}`,
    observedAt: NOW.toISOString(),
    tags: {},
    configuration: {
      state: "running",
      ...(sequence === 0 ? { vpcId: "node-00001" } : {}),
      ...(padding.length === 0 ? {} : { padding }),
    },
  };
}

const LIVE_CONNECTION = {
  tenantId: TENANT_ID,
  connectionId: CONNECTION_ID,
  expectedAccountId: "123456789012",
  partition: "aws" as const,
  roleArn: "arn:aws:iam::123456789012:role/sutra/SutraReadOnlyRole",
  externalId: "sutra_external_id_1234567890abcd",
  status: "ACTIVE" as const,
  permissionPackVersion: "standard-2026-07" as const,
  enabledRegions: ["us-east-1"],
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

test("public SSH candidates are protocol-aware and include IPv6 and all-protocol rules", () => {
  assert.equal(isPublicSshIngressCandidate([
    { protocol: "-1", ipv4Cidrs: ["0.0.0.0/0"], ipv6Cidrs: [] },
  ]), true);
  assert.equal(isPublicSshIngressCandidate([
    { protocol: "tcp", fromPort: 22, toPort: 22, ipv4Cidrs: [], ipv6Cidrs: ["::/0"] },
  ]), true);
  assert.equal(isPublicSshIngressCandidate([
    { protocol: "icmp", fromPort: 22, toPort: 22, ipv4Cidrs: ["0.0.0.0/0"], ipv6Cidrs: [] },
  ]), false);
  assert.equal(isPublicSshIngressCandidate([
    { protocol: "tcp", fromPort: 443, toPort: 443, ipv4Cidrs: ["0.0.0.0/0"], ipv6Cidrs: [] },
  ]), false);
});

test("live snapshots evaluate the advertised subnet public-IP control", () => {
  const subnet: NormalizedAwsResource = {
    schemaVersion: 1,
    provider: "aws",
    resourceKey: "aws:123456789012:us-east-1:ec2:aws.ec2.subnet:subnet-public",
    accountId: "123456789012",
    region: "us-east-1",
    service: "ec2",
    resourceType: "aws.ec2.subnet",
    resourceId: "subnet-public",
    arn: "arn:aws:ec2:us-east-1:123456789012:subnet/subnet-public",
    observedAt: NOW.toISOString(),
    tags: { Name: "public" },
    configuration: {
      state: "available",
      mapPublicIpOnLaunch: true,
    },
  };

  const snapshot = normalizeLiveSnapshot(
    LIVE_CONNECTION,
    "job_subnet_control_aaaaaaaaaaaaaaaaaaa",
    "sutra-job-subnet-control",
    [subnet],
    [],
    "COMPLETE",
    [{
      collectorKey: "ec2.subnets",
      region: "us-east-1",
      status: "SUCCEEDED",
      itemsObserved: 1,
      pagesObserved: 1,
    }],
    NOW,
  );

  const finding = snapshot.findings.find(
    (candidate) => candidate.controlKey === "SUTRA.AWS.EC2.SUBNET_AUTO_PUBLIC_IP",
  );
  assert.ok(finding);
  assert.equal(finding.resourceKey, snapshot.resources[0]?.resourceKey);
  assert.equal(finding.severity, "medium");
  assert.deepEqual(finding.evidence, { mapPublicIpOnLaunch: true });
});

test("live collector coverage is normalized without collapsing adapter failures", () => {
  assert.deepEqual(
    normalizeCollectorCoverage([
      {
        collectorKey: "ec2.instances",
        region: "us-east-1",
        status: "SUCCEEDED",
        itemsObserved: 25,
        pagesObserved: 3,
      },
      {
        collectorKey: "rds.db-instances",
        region: "us-west-2",
        status: "FAILED",
        itemsObserved: 0,
        pagesObserved: 0,
        errorCode: "AccessDeniedException",
        message: "The read-only AWS collector did not return a usable page.",
      },
    ]),
    [
      {
        collectorKey: "ec2.instances",
        region: "us-east-1",
        status: "succeeded",
        itemsObserved: 25,
        pagesObserved: 3,
      },
      {
        collectorKey: "rds.db-instances",
        region: "us-west-2",
        status: "failed",
        itemsObserved: 0,
        pagesObserved: 0,
        errorCode: "AccessDeniedException",
        message: "The read-only AWS collector did not return a usable page.",
      },
    ],
  );
});

test("bounded live evidence capture keeps the exact limit and fails safe on overflow", async () => {
  const sink = new BoundedLiveInventorySink(3);
  await sink.writeBatch({
    resources: [],
    evidence: [
      liveEvidence(1, "AWS_NATIVE_FINDING"),
      liveEvidence(2, "AWS_NATIVE_FINDING"),
      liveEvidence(3, "AWS_NATIVE_FINDING"),
    ],
  });

  assert.equal(sink.evidence.length, 3);
  assert.equal(sink.evidenceTruncation, null);

  await assert.doesNotReject(() =>
    sink.writeBatch({
      resources: [],
      evidence: [liveEvidence(4, "CLOUDTRAIL_LOGGING_STATUS")],
    }),
  );
  await assert.doesNotReject(() =>
    sink.writeBatch({
      resources: [],
      evidence: [liveEvidence(5, "AWS_NATIVE_FINDING")],
    }),
  );

  assert.equal(sink.evidence.length, 2);
  assert.equal(
    sink.evidence.filter((item) => item.evidenceType === "AWS_NATIVE_FINDING").length,
    1,
  );
  assert.ok(
    sink.evidence.some((item) => item.evidenceType === "CLOUDTRAIL_LOGGING_STATUS"),
  );
  assert.deepEqual(sink.evidenceTruncation, {
    evidenceLimit: 3,
    retainedEvidence: 2,
    droppedEvidence: 3,
    nativeFindingsDropped: 3,
    otherEvidenceDropped: 0,
  });
  assert.throws(() => new BoundedLiveInventorySink(0), /positive safe integer/u);
});

test("default live evidence budget turns the 5,001st observation into bounded truncation", async () => {
  const sink = new BoundedLiveInventorySink();
  await sink.writeBatch({
    resources: [],
    evidence: Array.from(
      { length: 5_000 },
      (_, index) => liveEvidence(index, "AWS_NATIVE_FINDING"),
    ),
  });

  assert.equal(sink.evidence.length, 5_000);
  assert.equal(sink.evidenceTruncation, null);

  await assert.doesNotReject(() =>
    sink.writeBatch({
      resources: [],
      evidence: [liveEvidence(5_001, "CLOUDTRAIL_LOGGING_STATUS")],
    }),
  );
  assert.equal(sink.evidence.length, 4_999);
  assert.ok(
    sink.evidence.some((item) => item.evidenceType === "CLOUDTRAIL_LOGGING_STATUS"),
  );
  assert.deepEqual(sink.evidenceTruncation, {
    evidenceLimit: 5_000,
    retainedEvidence: 4_999,
    droppedEvidence: 2,
    nativeFindingsDropped: 2,
    otherEvidenceDropped: 0,
  });
});

test("live snapshot exposes bounded evidence overflow as partial coverage and a finding", async () => {
  const sink = new BoundedLiveInventorySink(2);
  await sink.writeBatch({
    resources: [],
    evidence: [
      liveEvidence(1, "AWS_NATIVE_FINDING"),
      liveEvidence(2, "AWS_NATIVE_FINDING"),
      liveEvidence(3, "CLOUDTRAIL_LOGGING_STATUS"),
    ],
  });

  const snapshot = normalizeLiveSnapshot(
    {
      tenantId: TENANT_ID,
      connectionId: CONNECTION_ID,
      expectedAccountId: "123456789012",
      partition: "aws",
      roleArn: "arn:aws:iam::123456789012:role/sutra/SutraReadOnlyRole",
      externalId: "sutra_external_id_1234567890abcd",
      status: "ACTIVE",
      permissionPackVersion: "standard-2026-07",
      enabledRegions: ["us-east-1"],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
    "job_evidence_budget_aaaaaaaaaaaaaaaaaaaa",
    "sutra-job-evidence-budget",
    [],
    sink.evidence,
    "COMPLETE",
    [],
    NOW,
    sink.evidenceTruncation,
  );

  assert.equal(snapshot.coverageState, "partial");
  assert.deepEqual(snapshot.coverage, [
    {
      collectorKey: "sutra.evidence-budget",
      region: "global",
      status: "partial",
      itemsObserved: 1,
      pagesObserved: 0,
      errorCode: "EVIDENCE_BUDGET_EXCEEDED",
      message: "The bounded local collector omitted evidence and returned a partial snapshot.",
    },
  ]);
  const truncationFinding = snapshot.findings.find(
    (finding) => finding.controlKey === "SUTRA.COLLECTOR.EVIDENCE_BUDGET",
  );
  assert.ok(truncationFinding);
  assert.equal(truncationFinding.resourceKey, null);
  assert.deepEqual(truncationFinding.evidence, {
    evidenceLimit: 2,
    retainedEvidence: 1,
    droppedEvidence: 2,
    nativeFindingsDropped: 2,
    otherEvidenceDropped: 0,
  });
});

test("resource overflow retains a deterministic subset and is published as partial", async () => {
  const sink = new BoundedLiveInventorySink(10, 2);
  await assert.doesNotReject(() => sink.writeBatch({
    resources: [liveResource(3), liveResource(1), liveResource(2)],
    evidence: [],
  }));

  assert.deepEqual(
    sink.resources.map((resource) => resource.resourceId),
    ["node-00001", "node-00002"],
  );
  assert.deepEqual(sink.resourceTruncation, {
    resourceLimit: 2,
    retainedResources: 2,
    droppedResources: 1,
  });

  const snapshot = normalizeLiveSnapshot(
    LIVE_CONNECTION,
    "job_resource_budget_aaaaaaaaaaaaaaaaaaaa",
    "sutra-job-resource-budget",
    sink.resources,
    sink.evidence,
    "COMPLETE",
    [],
    NOW,
    sink.evidenceTruncation,
    sink.resourceTruncation,
  );
  assert.equal(snapshot.coverageState, "partial");
  assert.equal(
    snapshot.coverage.find((entry) => entry.collectorKey === "sutra.resource-budget")
      ?.errorCode,
    "RESOURCE_BUDGET_EXCEEDED",
  );
  assert.deepEqual(
    snapshot.findings.find(
      (finding) => finding.controlKey === "SUTRA.COLLECTOR.RESOURCE_BUDGET",
    )?.evidence,
    {
      resourceLimit: 2,
      retainedResources: 2,
      droppedResources: 1,
    },
  );
  assert.throws(
    () => new BoundedLiveInventorySink(10, 0),
    /resource limit must be a positive safe integer/u,
  );
});

test("over-12MiB normalized inputs become a deterministic relationship-safe partial snapshot", async () => {
  const padding = "x".repeat(4_000);
  const completedAt = new Date();
  const normalized = Array.from({ length: 4_000 }, (_, index) =>
    ({ ...liveResource(index, padding), observedAt: completedAt.toISOString() }));
  assert.ok(Buffer.byteLength(JSON.stringify(normalized), "utf8") > 12 * 1024 * 1024);

  const snapshot = normalizeLiveSnapshot(
    LIVE_CONNECTION,
    "job_snapshot_budget_aaaaaaaaaaaaaaaaaaaa",
    "sutra-job-snapshot-budget",
    normalized,
    [],
    "COMPLETE",
    [],
    completedAt,
  );
  const reversed = normalizeLiveSnapshot(
    LIVE_CONNECTION,
    "job_snapshot_budget_aaaaaaaaaaaaaaaaaaaa",
    "sutra-job-snapshot-budget",
    [...normalized].reverse(),
    [],
    "COMPLETE",
    [],
    completedAt,
  );
  const serializedBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");

  assert.equal(snapshot.coverageState, "partial");
  assert.ok(snapshot.resources.length > 0);
  assert.ok(snapshot.resources.length < normalized.length);
  assert.ok(serializedBytes <= LIVE_SNAPSHOT_RESPONSE_BUDGET_BYTES);
  assert.ok(serializedBytes < 12 * 1024 * 1024);
  assert.deepEqual(reversed.resources, snapshot.resources);
  assert.deepEqual(reversed.relationships, snapshot.relationships);
  assert.deepEqual(reversed.findings, snapshot.findings);
  assert.equal(reversed.snapshotSha256, snapshot.snapshotSha256);
  const resourceKeys = new Set(snapshot.resources.map((resource) => resource.resourceKey));
  assert.ok(snapshot.relationships.length > 0);
  assert.ok(snapshot.relationships.every((relationship) =>
    resourceKeys.has(relationship.fromResourceKey) &&
    resourceKeys.has(relationship.toResourceKey)));
  assert.equal(
    snapshot.coverage.find((entry) => entry.collectorKey === "sutra.snapshot-budget")
      ?.errorCode,
    "SNAPSHOT_BUDGET_EXCEEDED",
  );
  const budgetFinding = snapshot.findings.find(
    (finding) => finding.controlKey === "SUTRA.COLLECTOR.SNAPSHOT_BUDGET",
  );
  assert.ok(budgetFinding);
  assert.ok((budgetFinding.evidence.resourcesDropped as number) > 0);

  const boundaryModule = await import(
    new URL("../../../../lib/pilot-boundary.ts", import.meta.url).href
  ) as {
    readonly parsePilotSnapshot: (
      value: unknown,
      expected: {
        readonly jobId: string;
        readonly connectionId: string;
        readonly accountId: string;
        readonly partition: "aws";
      },
    ) => Promise<unknown>;
  };
  await boundaryModule.parsePilotSnapshot(snapshot, {
    jobId: "job_snapshot_budget_aaaaaaaaaaaaaaaaaaaa",
    connectionId: CONNECTION_ID,
    accountId: "123456789012",
    partition: "aws",
  });
});

test("live AWS mode is denied unless a sandbox is explicitly authorized", () => {
  assert.throws(
    () =>
      createLocalCollectorServer({
        sharedSecret: randomBytes(32).toString("base64url"),
        registryEncryptionKey: randomBytes(32).toString("base64url"),
        registryPath: join(tmpdir(), "sutra-live-mode-must-not-start.enc"),
        mode: "live",
        principalArn: "arn:aws:iam::999988887777:role/SutraLocalCollector",
      }),
    /Live AWS access is disabled/u,
  );
});

test("signed loopback fixture API completes register, trust verification, and sync", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-server-"));
  const sharedSecret = randomBytes(32).toString("base64url");
  const server = createLocalCollectorServer({
    sharedSecret,
    registryEncryptionKey: randomBytes(32).toString("base64url"),
    registryPath: join(directory, "registry.enc"),
    localJobStatePath: join(directory, "local-jobs.json"),
    localJobWorkerEnabled: false,
    mode: "fixture",
    now: () => NOW,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const health = await signedRequest(baseUrl, sharedSecret, "GET", "/v1/health");
    assert.equal(health.status, 200);
    assert.deepEqual(health.value, {
      ok: true,
      mode: "fixture",
      version: "0.2.0-pilot",
      principalArn: "arn:aws:iam::999988887777:role/SutraLocalCollector",
      sourceAccountId: "999988887777",
      message: "Fixture collector ready; no AWS API calls will be made.",
    });

    const compensatedConnectionId = "conn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const compensatedRegistration = {
      tenantId: TENANT_ID,
      connectionId: compensatedConnectionId,
      accountId: "123456789012",
      partition: "aws",
      roleArn: "arn:aws:iam::123456789012:role/mspcmdb/SutraReadOnlyRole",
      externalId: "sutra_external_id_1234567890abcd",
      enabledRegions: ["us-east-1", "ap-south-1"],
    };
    assert.equal((await signedRequest(
      baseUrl,
      sharedSecret,
      "PUT",
      `/v1/connections/${compensatedConnectionId}`,
      compensatedRegistration,
    )).status, 200);
    const discarded = await signedRequest(
      baseUrl,
      sharedSecret,
      "POST",
      `/v1/connections/${compensatedConnectionId}/discard`,
      {
        tenantId: TENANT_ID,
        connectionId: compensatedConnectionId,
        roleArn: compensatedRegistration.roleArn,
      },
    );
    assert.equal(discarded.status, 200);
    assert.deepEqual(discarded.value, { discarded: true });
    // Compensation does not write an offboarding tombstone, so retry works.
    assert.equal((await signedRequest(
      baseUrl,
      sharedSecret,
      "PUT",
      `/v1/connections/${compensatedConnectionId}`,
      compensatedRegistration,
    )).status, 200);

    const registration = await signedRequest(
      baseUrl,
      sharedSecret,
      "PUT",
      `/v1/connections/${CONNECTION_ID}`,
      {
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        accountId: "123456789012",
        partition: "aws",
        roleArn: "arn:aws:iam::123456789012:role/mspcmdb/SutraReadOnlyRole",
        externalId: "sutra_external_id_1234567890abcd",
        enabledRegions: ["us-east-1", "ap-south-1"],
      },
    );
    assert.equal(registration.status, 200);
    assert.deepEqual(registration.value, { registered: true });

    const verification = await signedRequest(
      baseUrl,
      sharedSecret,
      "POST",
      `/v1/connections/${CONNECTION_ID}/verify`,
      {
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        jobId: "verify_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    );
    assert.equal(verification.status, 200);
    const verificationValue = verification.value as Record<string, unknown>;
    assert.equal(verificationValue.verified, true);
    assert.equal(verificationValue.accountId, "123456789012");
    assert.equal(verificationValue.missingExternalIdDenied, true);
    assert.equal(verificationValue.wrongExternalIdDenied, true);

    const stagedSync = await signedRequest(
      baseUrl,
      sharedSecret,
      "POST",
      `/v1/connections/${CONNECTION_ID}/sync`,
      {
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        jobId: "sync_staged_aaaaaaaaaaaaaaaaaaaaaaa",
      },
    );
    assert.equal(stagedSync.status, 409);

    const activated = await signedRequest(
      baseUrl,
      sharedSecret,
      "POST",
      `/v1/connections/${CONNECTION_ID}/activate`,
      {
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        roleArn: "arn:aws:iam::123456789012:role/mspcmdb/SutraReadOnlyRole",
      },
    );
    assert.equal(activated.status, 200);
    assert.deepEqual(activated.value, { activated: true });

    const sync = await signedRequest(
      baseUrl,
      sharedSecret,
      "POST",
      `/v1/connections/${CONNECTION_ID}/sync`,
      {
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        jobId: "sync_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    );
    assert.equal(sync.status, 200);
    const snapshot = sync.value as Record<string, unknown>;
    assert.equal(snapshot.schemaVersion, "sutra.inventory.v1");
    assert.equal(snapshot.coverageState, "complete");
    assert.equal((snapshot.resources as unknown[]).length, 16);
    assert.equal((snapshot.findings as unknown[]).length, 11);
    assert.match(snapshot.snapshotSha256 as string, /^[a-f0-9]{64}$/u);

    const disabled = await signedRequest(
      baseUrl,
      sharedSecret,
      "POST",
      `/v1/connections/${CONNECTION_ID}/disable`,
      { tenantId: TENANT_ID, connectionId: CONNECTION_ID },
    );
    assert.equal(disabled.status, 200);
    assert.deepEqual(disabled.value, { disabled: true });
    assert.doesNotMatch(JSON.stringify(disabled.value), /externalId|roleArn|credentials/iu);

    const disabledSync = await signedRequest(
      baseUrl,
      sharedSecret,
      "POST",
      `/v1/connections/${CONNECTION_ID}/sync`,
      {
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        jobId: "sync_disabled_aaaaaaaaaaaaaaaaaaaaaa",
      },
    );
    assert.equal(disabledSync.status, 409);

    const delayedRegistration = await signedRequest(
      baseUrl,
      sharedSecret,
      "PUT",
      `/v1/connections/${CONNECTION_ID}`,
      {
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        accountId: "123456789012",
        partition: "aws",
        roleArn: "arn:aws:iam::123456789012:role/mspcmdb/SutraReadOnlyRole",
        externalId: "sutra_rotated_external_id_123456789",
        enabledRegions: ["us-east-1", "ap-south-1"],
      },
    );
    assert.equal(delayedRegistration.status, 409);

    const offboarded = await signedRequest(
      baseUrl,
      sharedSecret,
      "POST",
      `/v1/connections/${CONNECTION_ID}/offboard`,
      { tenantId: TENANT_ID, connectionId: CONNECTION_ID },
    );
    assert.equal(offboarded.status, 200);
    assert.deepEqual(offboarded.value, { offboarded: true });

    const offboardedRegistration = await signedRequest(
      baseUrl,
      sharedSecret,
      "PUT",
      `/v1/connections/${CONNECTION_ID}`,
      {
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        accountId: "123456789012",
        partition: "aws",
        roleArn: "arn:aws:iam::123456789012:role/mspcmdb/SutraReadOnlyRole",
        externalId: "sutra_rotated_external_id_123456789",
        enabledRegions: ["us-east-1", "ap-south-1"],
      },
    );
    assert.equal(offboardedRegistration.status, 409);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixture API rejects unknown fields after authenticating the request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-server-"));
  const sharedSecret = randomBytes(32).toString("base64url");
  const server = createLocalCollectorServer({
    sharedSecret,
    registryEncryptionKey: randomBytes(32).toString("base64url"),
    registryPath: join(directory, "registry.enc"),
    localJobStatePath: join(directory, "local-jobs.json"),
    localJobWorkerEnabled: false,
    mode: "fixture",
    now: () => NOW,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await signedRequest(
      `http://127.0.0.1:${port}`,
      sharedSecret,
      "POST",
      `/v1/connections/${CONNECTION_ID}/sync`,
      {
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        jobId: "sync_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        externalId: "must-not-be-accepted",
      },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(response.value, {
      code: "INVALID_REQUEST",
      message: "The collector request is invalid",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("signed local fixture jobs are strict, idempotent, durable, and return verified snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-local-jobs-api-"));
  const sharedSecret = randomBytes(32).toString("base64url");
  const registryPath = join(directory, "registry.enc");
  const localJobStatePath = join(directory, "local-jobs.json");
  const createServerOptions = {
    sharedSecret,
    registryEncryptionKey: randomBytes(32).toString("base64url"),
    registryPath,
    localJobStatePath,
    mode: "fixture" as const,
    now: () => NOW,
    localJobPollIntervalMs: 5,
    localJobLeaseMs: 1_000,
    localJobWorkerId: "fixture-api-test-worker",
  };
  const firstServer = createLocalCollectorServer({
    ...createServerOptions,
    localJobWorkerEnabled: false,
  });
  const firstBaseUrl = await listen(firstServer);
  let jobId = "";
  try {
    const catalog = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "GET",
      "/v1/local/fixtures",
    );
    assert.equal(catalog.status, 200);
    const fixtures = (catalog.value as { fixtures: unknown[] }).fixtures;
    assert.equal(fixtures.length, 3);
    const serializedCatalog = JSON.stringify(catalog.value);
    assert.doesNotMatch(serializedCatalog, /externalId|roleArn|credentials/iu);

    const invalidLimit = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "GET",
      "/v1/local/jobs?limit=0",
    );
    assert.equal(invalidLimit.status, 400);

    const invalidBody = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "POST",
      "/v1/local/jobs/simulated-sync",
      {
        tenantId: TENANT_ID,
        fixtureId: "northstar-retail",
        version: "2026.07.0",
        idempotencyKey: "demo-sync-01",
        externalId: "must-not-be-accepted",
      },
    );
    assert.equal(invalidBody.status, 400);

    const enqueued = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "POST",
      "/v1/local/jobs/simulated-sync",
      {
        tenantId: TENANT_ID,
        fixtureId: "northstar-retail",
        version: "2026.07.0",
        idempotencyKey: "demo-sync-01",
      },
    );
    assert.equal(enqueued.status, 202);
    const enqueuedValue = enqueued.value as {
      created: boolean;
      job: {
        jobId: string;
        status: string;
        triggerKind: string;
        scheduleId: string | null;
      };
    };
    assert.equal(enqueuedValue.created, true);
    assert.equal(enqueuedValue.job.status, "pending");
    assert.equal(enqueuedValue.job.triggerKind, "manual");
    assert.equal(enqueuedValue.job.scheduleId, null);
    jobId = enqueuedValue.job.jobId;
    assert.match(jobId, /^job_[a-f0-9]{48}$/u);

    const replayed = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "POST",
      "/v1/local/jobs/simulated-sync",
      {
        tenantId: TENANT_ID,
        fixtureId: "northstar-retail",
        version: "2026.07.0",
        idempotencyKey: "demo-sync-01",
      },
    );
    assert.equal(replayed.status, 200);
    assert.equal((replayed.value as { created: boolean }).created, false);
    assert.equal(
      (replayed.value as { job: { jobId: string } }).job.jobId,
      jobId,
    );

    const conflict = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "POST",
      "/v1/local/jobs/simulated-sync",
      {
        tenantId: TENANT_ID,
        fixtureId: "northstar-retail",
        version: "2026.07.1",
        idempotencyKey: "demo-sync-01",
      },
    );
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.value, {
      code: "IDEMPOTENCY_CONFLICT",
      message: "The idempotency key is already bound to another local fixture request",
    });

    const reservedScheduleProvenance = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "POST",
      "/v1/local/jobs/simulated-sync",
      {
        tenantId: TENANT_ID,
        fixtureId: "northstar-retail",
        version: "2026.07.0",
        idempotencyKey: `schedule:${SCHEDULE_ID}:${NOW.toISOString()}`,
      },
    );
    assert.equal(reservedScheduleProvenance.status, 400);

    const jobs = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "GET",
      "/v1/local/jobs?limit=1",
    );
    assert.equal(jobs.status, 200);
    assert.equal((jobs.value as { count: number }).count, 1);
    const serializedJobs = JSON.stringify(jobs.value);
    assert.doesNotMatch(
      serializedJobs,
      /leaseToken|requestSha256|snapshot|externalId|roleArn|credentials/iu,
    );

    const secondCustomer = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "POST",
      "/v1/local/jobs/simulated-sync",
      {
        tenantId: TENANT_ID,
        fixtureId: "meridian-health",
        version: "2026.07.0",
        idempotencyKey: "demo-sync-02",
      },
    );
    assert.equal(secondCustomer.status, 202);
    const scopedJobs = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "GET",
      `/v1/local/jobs?limit=100&tenantId=${TENANT_ID}&customerId=cust_11111111111111111111111111111111`,
    );
    assert.equal(scopedJobs.status, 200);
    const scopedValue = scopedJobs.value as {
      count: number;
      jobs: Array<{ tenantId: string; customerId: string; fixtureId: string }>;
    };
    assert.equal(scopedValue.count, 1);
    assert.ok(scopedValue.jobs.every((job) =>
      job.tenantId === TENANT_ID &&
      job.customerId === "cust_11111111111111111111111111111111" &&
      job.fixtureId === "northstar-retail"));

    const incompleteScope = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "GET",
      `/v1/local/jobs?limit=10&customerId=cust_11111111111111111111111111111111`,
    );
    assert.equal(incompleteScope.status, 400);
  } finally {
    await close(firstServer);
  }

  const restartedServer = createLocalCollectorServer(createServerOptions);
  const restartedBaseUrl = await listen(restartedServer);
  try {
    const completed = await pollSignedRequest(
      () =>
        signedRequest(
          restartedBaseUrl,
          sharedSecret,
          "GET",
          `/v1/local/jobs/${jobId}/result?tenantId=${TENANT_ID}&customerId=${CUSTOMER_ID}`,
        ),
      (response) => response.status === 200,
    );
    const completedValue = completed.value as {
      job: { status: string; attempts: number };
      result: {
        fixtureId: string;
        snapshot: {
          schemaVersion: string;
          resources: unknown[];
          snapshotSha256: string;
        };
      };
    };
    assert.equal(completedValue.job.status, "succeeded");
    assert.equal(completedValue.job.attempts, 1);
    assert.equal(completedValue.result.fixtureId, "northstar-retail");
    assert.equal(completedValue.result.snapshot.schemaVersion, "sutra.inventory.v1");
    assert.equal(completedValue.result.snapshot.resources.length, 16);
    assert.match(completedValue.result.snapshot.snapshotSha256, /^[a-f0-9]{64}$/u);

    const wrongResultScope = await signedRequest(
      restartedBaseUrl,
      sharedSecret,
      "GET",
      `/v1/local/jobs/${jobId}/result?tenantId=${TENANT_ID}&customerId=cust_22222222222222222222222222222222`,
    );
    assert.equal(wrongResultScope.status, 404);
    const reviewBeforePublication = await signedRequest(
      restartedBaseUrl,
      sharedSecret,
      "GET",
      `/v1/local/jobs?limit=100&tenantId=${TENANT_ID}&customerId=${CUSTOMER_ID}&reviewRequired=true`,
    );
    assert.equal((reviewBeforePublication.value as { count: number }).count, 1);
    const acknowledged = await signedRequest(
      restartedBaseUrl,
      sharedSecret,
      "POST",
      `/v1/local/jobs/${jobId}/published`,
      {
        tenantId: TENANT_ID,
        customerId: CUSTOMER_ID,
        publicationId: "snapshot_local_test",
        publishedAt: NOW.toISOString(),
      },
    );
    assert.deepEqual(acknowledged.value, { acknowledged: true });
    const reviewAfterPublication = await signedRequest(
      restartedBaseUrl,
      sharedSecret,
      "GET",
      `/v1/local/jobs?limit=100&tenantId=${TENANT_ID}&customerId=${CUSTOMER_ID}&reviewRequired=true`,
    );
    assert.equal((reviewAfterPublication.value as { count: number }).count, 0);

    const compactJobs = await signedRequest(
      restartedBaseUrl,
      sharedSecret,
      "GET",
      "/v1/local/jobs?limit=1",
    );
    assert.doesNotMatch(JSON.stringify(compactJobs.value), /snapshot|leaseToken/iu);
  } finally {
    await close(restartedServer);
    await rm(directory, { recursive: true, force: true });
  }
});

test("signed local schedules persist, enforce catalog scope, and create provenance-safe jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-local-schedules-api-"));
  const sharedSecret = randomBytes(32).toString("base64url");
  const localJobStatePath = join(directory, "local-jobs.json");
  let clock = NOW;
  const createServerOptions = {
    sharedSecret,
    registryEncryptionKey: randomBytes(32).toString("base64url"),
    registryPath: join(directory, "registry.enc"),
    localJobStatePath,
    mode: "fixture" as const,
    now: () => clock,
    localJobPollIntervalMs: 5,
    localJobLeaseMs: 1_000,
    localJobWorkerId: "schedule-api-test-worker",
    localScheduleMaxCatchUpPerTick: 2,
  };
  const firstServer = createLocalCollectorServer({
    ...createServerOptions,
    localJobWorkerEnabled: false,
  });
  const firstBaseUrl = await listen(firstServer);
  const initialRunAt = new Date(NOW.getTime() - 60_000).toISOString();
  try {
    const invalidScope = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "PUT",
      `/v1/local/schedules/${SCHEDULE_ID}`,
      {
        tenantId: "org_other_tenant",
        mutationId: UPSERT_MUTATION_ID,
        mutationSequence: 1,
        fixtureId: "northstar-retail",
        version: "2026.07.1",
        everyMs: 1_000,
        enabled: false,
        firstRunAt: initialRunAt,
      },
    );
    assert.equal(invalidScope.status, 400);

    const extraField = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "PUT",
      `/v1/local/schedules/${SCHEDULE_ID}`,
      {
        tenantId: TENANT_ID,
        mutationId: UPSERT_MUTATION_ID,
        mutationSequence: 1,
        fixtureId: "northstar-retail",
        version: "2026.07.1",
        everyMs: 1_000,
        enabled: false,
        firstRunAt: initialRunAt,
        customerId: CUSTOMER_ID,
      },
    );
    assert.equal(extraField.status, 400);

    const upserted = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "PUT",
      `/v1/local/schedules/${SCHEDULE_ID}`,
      {
        tenantId: TENANT_ID,
        mutationId: UPSERT_MUTATION_ID,
        mutationSequence: 1,
        fixtureId: "northstar-retail",
        version: "2026.07.1",
        everyMs: 1_000,
        enabled: false,
        firstRunAt: initialRunAt,
      },
    );
    assert.equal(upserted.status, 200);
    const upsertedSchedule = (upserted.value as { schedule: Record<string, unknown> })
      .schedule;
    assert.deepEqual(Object.keys(upsertedSchedule).sort(), [
      "capacityBlockedAt",
      "capacitySkippedOccurrences",
      "capacityState",
      "connectionId",
      "createdAt",
      "customerId",
      "enabled",
      "everyMs",
      "fixtureId",
      "lastMissedAt",
      "maxAttempts",
      "missedOccurrences",
      "nextRunAt",
      "scheduleId",
      "tenantId",
      "updatedAt",
      "version",
    ]);
    assert.equal(upsertedSchedule.scheduleId, SCHEDULE_ID);
    assert.equal(upsertedSchedule.customerId, CUSTOMER_ID);
    assert.equal(upsertedSchedule.connectionId, CONNECTION_ID);
    assert.equal(upsertedSchedule.nextRunAt, initialRunAt);
    assert.equal(upsertedSchedule.enabled, false);
    assert.doesNotMatch(
      JSON.stringify(upserted.value),
      /payload|idempotencyKey|externalId|roleArn|credentials/iu,
    );

    const listed = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "GET",
      `/v1/local/schedules?tenantId=${TENANT_ID}&customerId=${CUSTOMER_ID}`,
    );
    assert.equal(listed.status, 200);
    assert.equal((listed.value as { count: number }).count, 1);

    const incompleteScope = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "GET",
      `/v1/local/schedules?tenantId=${TENANT_ID}`,
    );
    assert.equal(incompleteScope.status, 400);

    const wrongTenantToggle = await signedRequest(
      firstBaseUrl,
      sharedSecret,
      "POST",
      `/v1/local/schedules/${SCHEDULE_ID}/enabled`,
      {
        tenantId: "org_other_tenant",
        enabled: true,
        mutationId: ENABLE_MUTATION_ID,
        mutationSequence: 2,
      },
    );
    assert.equal(wrongTenantToggle.status, 404);
  } finally {
    await close(firstServer);
  }

  const restartedServer = createLocalCollectorServer(createServerOptions);
  const restartedBaseUrl = await listen(restartedServer);
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const jobsWhileDisabled = await signedRequest(
      restartedBaseUrl,
      sharedSecret,
      "GET",
      `/v1/local/jobs?limit=100&tenantId=${TENANT_ID}&customerId=${CUSTOMER_ID}`,
    );
    assert.equal((jobsWhileDisabled.value as { count: number }).count, 0);

    const persisted = await signedRequest(
      restartedBaseUrl,
      sharedSecret,
      "GET",
      `/v1/local/schedules?tenantId=${TENANT_ID}&customerId=${CUSTOMER_ID}`,
    );
    const [persistedSchedule] = (persisted.value as {
      schedules: Array<{ scheduleId: string; enabled: boolean; nextRunAt: string }>;
    }).schedules;
    assert.equal(persistedSchedule?.scheduleId, SCHEDULE_ID);
    assert.equal(persistedSchedule?.enabled, false);
    assert.equal(persistedSchedule?.nextRunAt, initialRunAt);

    clock = new Date(NOW.getTime() + 20_000);
    const enabled = await signedRequest(
      restartedBaseUrl,
      sharedSecret,
      "POST",
      `/v1/local/schedules/${SCHEDULE_ID}/enabled`,
      {
        tenantId: TENANT_ID,
        enabled: true,
        mutationId: ENABLE_MUTATION_ID,
        mutationSequence: 2,
      },
    );
    const enabledSchedule = (enabled.value as {
      schedule: { enabled: boolean; nextRunAt: string };
    }).schedule;
    assert.equal(enabled.status, 200);
    assert.equal(enabledSchedule.enabled, true);
    assert.equal(enabledSchedule.nextRunAt, clock.toISOString());

    const firstScheduledJob = await pollSignedRequest(
      () =>
        signedRequest(
          restartedBaseUrl,
          sharedSecret,
          "GET",
          `/v1/local/jobs?limit=100&tenantId=${TENANT_ID}&customerId=${CUSTOMER_ID}`,
        ),
      (response) => {
        const jobs = (response.value as {
          jobs: Array<{ status: string; triggerKind: string; scheduleId: string | null }>;
        }).jobs;
        return jobs.length === 1 && jobs[0]?.status === "succeeded";
      },
    );
    const [scheduledJob] = (firstScheduledJob.value as {
      jobs: Array<{ triggerKind: string; scheduleId: string | null }>;
    }).jobs;
    assert.equal(scheduledJob?.triggerKind, "scheduled");
    assert.equal(scheduledJob?.scheduleId, SCHEDULE_ID);

    const disabled = await signedRequest(
      restartedBaseUrl,
      sharedSecret,
      "POST",
      `/v1/local/schedules/${SCHEDULE_ID}/enabled`,
      {
        tenantId: TENANT_ID,
        enabled: false,
        mutationId: DISABLE_MUTATION_ID,
        mutationSequence: 3,
      },
    );
    assert.equal(
      (disabled.value as { schedule: { enabled: boolean } }).schedule.enabled,
      false,
    );
    clock = new Date(NOW.getTime() + 40_000);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const stillOneJob = await signedRequest(
      restartedBaseUrl,
      sharedSecret,
      "GET",
      `/v1/local/jobs?limit=100&tenantId=${TENANT_ID}&customerId=${CUSTOMER_ID}`,
    );
    assert.equal((stillOneJob.value as { count: number }).count, 1);

    const reenabled = await signedRequest(
      restartedBaseUrl,
      sharedSecret,
      "POST",
      `/v1/local/schedules/${SCHEDULE_ID}/enabled`,
      {
        tenantId: TENANT_ID,
        enabled: true,
        mutationId: REENABLE_MUTATION_ID,
        mutationSequence: 4,
      },
    );
    assert.equal(
      (reenabled.value as { schedule: { nextRunAt: string } }).schedule.nextRunAt,
      clock.toISOString(),
    );
    const stale = await signedRequest(
      restartedBaseUrl,
      sharedSecret,
      "POST",
      `/v1/local/schedules/${SCHEDULE_ID}/enabled`,
      {
        tenantId: TENANT_ID,
        enabled: false,
        mutationId: STALE_MUTATION_ID,
        mutationSequence: 3,
      },
    );
    assert.equal(stale.status, 409);
    assert.equal((stale.value as { code: string }).code, "STALE_SCHEDULE_MUTATION");
    const secondScheduledJob = await pollSignedRequest(
      () =>
        signedRequest(
          restartedBaseUrl,
          sharedSecret,
          "GET",
          `/v1/local/jobs?limit=100&tenantId=${TENANT_ID}&customerId=${CUSTOMER_ID}`,
        ),
      (response) => {
        const jobs = (response.value as { jobs: Array<{ status: string }> }).jobs;
        return jobs.length === 2 && jobs.every((job) => job.status === "succeeded");
      },
    );
    assert.equal((secondScheduledJob.value as { count: number }).count, 2);
  } finally {
    await close(restartedServer);
    await rm(directory, { recursive: true, force: true });
  }
});

test("local fixture worker retries a failed lease with backoff before succeeding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-local-worker-"));
  const sharedSecret = randomBytes(32).toString("base64url");
  let clock = NOW;
  let executions = 0;
  const server = createLocalCollectorServer({
    sharedSecret,
    registryEncryptionKey: randomBytes(32).toString("base64url"),
    registryPath: join(directory, "registry.enc"),
    mode: "fixture",
    now: () => clock,
    localJobStore: new MemoryLocalJobStateStore(),
    localJobWorkerId: "retry-test-worker",
    localJobPollIntervalMs: 5,
    localJobLeaseMs: 1_000,
    localJobBaseBackoffMs: 10,
    localJobMaxBackoffMs: 10,
    localFixtureJobExecutor: (input) => {
      executions += 1;
      if (executions === 1) throw new Error("injected retry");
      return executeLocalFixtureCollectionJob(input);
    },
  });
  const baseUrl = await listen(server);
  try {
    const enqueued = await signedRequest(
      baseUrl,
      sharedSecret,
      "POST",
      "/v1/local/jobs/simulated-sync",
      {
        tenantId: TENANT_ID,
        fixtureId: "meridian-health",
        version: "2026.07.1",
        idempotencyKey: "retry-sync-01",
      },
    );
    const jobId = (enqueued.value as { job: { jobId: string } }).job.jobId;
    await pollSignedRequest(
      () =>
        signedRequest(baseUrl, sharedSecret, "GET", "/v1/local/jobs?limit=10"),
      (response) => {
        const jobs = (response.value as { jobs: Array<{ attempts: number; status: string }> })
          .jobs;
        return jobs[0]?.attempts === 1 && jobs[0]?.status === "pending";
      },
    );
    clock = new Date(NOW.getTime() + 20);
    const completed = await pollSignedRequest(
      () =>
        signedRequest(
          baseUrl,
          sharedSecret,
          "GET",
          `/v1/local/jobs/${jobId}/result?tenantId=${TENANT_ID}&customerId=${MERIDIAN_CUSTOMER_ID}`,
        ),
      (response) => response.status === 200,
    );
    assert.equal((completed.value as { job: { attempts: number } }).job.attempts, 2);
    assert.equal(executions, 2);
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

async function listen(server: ReturnType<typeof createLocalCollectorServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: ReturnType<typeof createLocalCollectorServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // The HTTP server closes synchronously; allow an already-leased file-store
  // operation to observe the worker stop before deleting its temporary directory.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function pollSignedRequest(
  request: () => Promise<{ readonly status: number; readonly value: unknown }>,
  complete: (response: { readonly status: number; readonly value: unknown }) => boolean,
): Promise<{ readonly status: number; readonly value: unknown }> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await request();
    if (complete(response)) return response;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the local fixture worker");
}

async function signedRequest(
  baseUrl: string,
  sharedSecret: string,
  method: "GET" | "PUT" | "POST",
  path: string,
  payload?: unknown,
): Promise<{ readonly status: number; readonly value: unknown }> {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const timestamp = NOW.getTime().toString();
  const nonce = `nonce_${randomBytes(18).toString("base64url")}`;
  const signature = hmac(
    sharedSecret,
    `${method}\n${path}\n${timestamp}\n${nonce}\n${sha256(body)}`,
  );
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "x-sutra-timestamp": timestamp,
      "x-sutra-nonce": nonce,
      "x-sutra-signature": signature,
      ...(body.length === 0 ? {} : { "content-type": "application/json" }),
    },
    ...(body.length === 0 ? {} : { body }),
  });
  const responseText = await response.text();
  assert.equal(
    response.headers.get("x-sutra-response-signature"),
    hmac(sharedSecret, `${response.status}\n${path}\n${nonce}\n${sha256(responseText)}`),
  );
  return { status: response.status, value: JSON.parse(responseText) as unknown };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(value, "utf8")
    .digest("hex");
}
