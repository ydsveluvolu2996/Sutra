import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { executeLocalFixtureCollectionJob } from "../src/local-fixture-catalog.js";
import { MemoryLocalJobStateStore } from "../src/local-job-state.js";
import { createLocalCollectorServer } from "../src/local-server.js";

const NOW = new Date("2026-07-15T10:00:00.000Z");
const TENANT_ID = "org_local_sutra";
const CONNECTION_ID = "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
    assert.equal((snapshot.resources as unknown[]).length, 13);
    assert.equal((snapshot.findings as unknown[]).length, 11);
    assert.match(snapshot.snapshotSha256 as string, /^[a-f0-9]{64}$/u);
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
      job: { jobId: string; status: string };
    };
    assert.equal(enqueuedValue.created, true);
    assert.equal(enqueuedValue.job.status, "pending");
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
          `/v1/local/jobs/${jobId}/result`,
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
    assert.equal(completedValue.result.snapshot.resources.length, 13);
    assert.match(completedValue.result.snapshot.snapshotSha256, /^[a-f0-9]{64}$/u);

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
          `/v1/local/jobs/${jobId}/result`,
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
