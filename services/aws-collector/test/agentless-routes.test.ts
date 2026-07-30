import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createLocalCollectorServer } from "../src/local-server.js";
import { RegistryStateError } from "../src/local-registry.js";

/**
 * Route-level tests for the agentless execute and poll endpoints.
 *
 * No AWS: the environment below disables IMDS and supplies no credentials, so the
 * scan-account assume inside createAgentlessExecutor fails immediately. That is
 * exactly the case worth pinning anyway — a request that CANNOT reach AWS must be
 * answered as "no scan started, nothing billing", never as a scan with no findings.
 */
process.env.AWS_EC2_METADATA_DISABLED = "true";
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
delete process.env.AWS_SESSION_TOKEN;
delete process.env.AWS_PROFILE;

const NOW = new Date("2026-07-29T12:00:00.000Z");
const TENANT_ID = "org_local_sutra";
const CONNECTION_ID = "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RUN_ID = "scan_01HXYZABCDEF";

const SETTINGS = {
  scanAccountId: "738663485493",
  scanAvailabilityZone: "ap-south-1a",
  kmsKeyArn: null,
  scannerImage:
    "738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/agentless-scanner@sha256:"
    + "7c525ef4a8deb23a3ea4d9f1a232244b3054241a2601c74e3fe32d1ed81fefc6",
  liveValidated: true,
  orchestratorRoleArn: "arn:aws:iam::738663485493:role/sutra/SutraAgentlessOrchestrator",
  instance: {
    amiId: "ami-0abcdef1234567890",
    instanceType: "t3.medium",
    subnetId: "subnet-0a010828a2ca84cdd",
    securityGroupId: "sg-015790dfd771987fb",
    instanceProfileArn:
      "arn:aws:iam::738663485493:instance-profile/sutra/ScannerInstanceProfile",
    findingsBucket: "sutra-agentless-scan-findingsbucket-5at3eakxktgc",
  },
};

const PLAN = {
  schema: "sutra.aws-agentless-scan-plan.v1",
  mode: "plan",
  scanAccountId: SETTINGS.scanAccountId,
  scanners: ["vuln"],
  kmsReencrypt: false,
  summary: { snapshotTtlHours: 6 },
  volumes: [{ volumeId: "vol-0a1b2c3d4e5f6a7b8", region: "ap-south-1" }],
};

const REQUEST = {
  tenantId: TENANT_ID,
  connectionId: CONNECTION_ID,
  plan: PLAN,
};

async function withServer(
  run: (baseUrl: string, secret: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "sutra-agentless-routes-"));
  const sharedSecret = randomBytes(32).toString("base64url");
  const server = createLocalCollectorServer({
    sharedSecret,
    registryEncryptionKey: randomBytes(32).toString("base64url"),
    registryPath: join(directory, "connections.enc.json"),
    localJobStatePath: join(directory, "local-jobs.json"),
    mode: "fixture",
    allowLiveAws: false,
    principalArn: "arn:aws:iam::999988887777:role/SutraLocalCollector",
    hostedAgentlessSettings: SETTINGS,
    now: () => NOW,
  });
  try {
    const baseUrl = await listen(server);
    await run(baseUrl, sharedSecret);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test("a request that cannot reach AWS is answered as no scan started", async () => {
  await withServer(async (baseUrl, secret) => {
    const started = await signedRequest(
      baseUrl, secret, "POST", `/v1/agentless/scans/${RUN_ID}/execute`, REQUEST,
    );
    // 503, not 500 and certainly not 202-with-no-findings.
    assert.equal(started.status, 503);
    const value = started.value as { code?: string; interpretation?: string };
    assert.match(String(value.interpretation), /No scan started/u);
    assert.match(String(value.interpretation), /nothing is billing/u);
    assert.match(String(value.interpretation), /do NOT read this as a clean scan/iu);

    // The failure is recorded, so a poll reports it rather than reporting nothing.
    const polled = await signedRequest(
      baseUrl, secret, "GET",
      `/v1/agentless/scans/${RUN_ID}?tenantId=${TENANT_ID}&connectionId=${CONNECTION_ID}`,
    );
    assert.equal(polled.status, 200);
    const state = polled.value as { phase?: string; execution?: unknown; error?: { code?: string } };
    assert.equal(state.phase, "failed");
    assert.equal(state.execution, null, "a failed scan must never carry findings");
    assert.ok(typeof state.error?.code === "string" && state.error.code.length > 0);
  });
});

test("an untracked run is 404 and says to check AWS, not that it is clean", async () => {
  await withServer(async (baseUrl, secret) => {
    const polled = await signedRequest(
      baseUrl, secret, "GET",
      `/v1/agentless/scans/scan_neverstarted?tenantId=${TENANT_ID}&connectionId=${CONNECTION_ID}`,
    );
    assert.equal(polled.status, 404);
    const value = polled.value as { code?: string; interpretation?: string };
    assert.equal(value.code, "RUN_NOT_TRACKED");
    assert.match(String(value.interpretation), /check AWS/u);
    assert.match(String(value.interpretation), /NOT read this as a completed or clean scan/u);
  });
});

test("a run is invisible to another tenant", async () => {
  await withServer(async (baseUrl, secret) => {
    await signedRequest(baseUrl, secret, "POST", `/v1/agentless/scans/${RUN_ID}/execute`, REQUEST);
    const foreign = await signedRequest(
      baseUrl, secret, "GET",
      `/v1/agentless/scans/${RUN_ID}?tenantId=org_someone_else&connectionId=${CONNECTION_ID}`,
    );
    // Indistinguishable from a run that does not exist: a run id is not a capability.
    assert.equal(foreign.status, 404);
  });
});

test("a poll without a scope is refused rather than defaulted", async () => {
  await withServer(async (baseUrl, secret) => {
    const noScope = await signedRequest(baseUrl, secret, "GET", `/v1/agentless/scans/${RUN_ID}`);
    assert.equal(noScope.status, 400);
  });
});

test("malformed and dangerous requests are refused before anything is claimed", async () => {
  await withServer(async (baseUrl, secret) => {
    const cases: readonly (readonly [string, unknown, number])[] = [
      ["not an object", "nope", 400],
      ["missing plan", { ...REQUEST, plan: undefined }, 400],
      // Would scan a disk and report nothing found, indistinguishable from clean.
      ["empty scanner list", { ...REQUEST, plan: { ...PLAN, scanners: [] } }, 400],
      // Infrastructure settings are broker-owned and cannot be overridden by a client.
      ["client supplied settings", {
        ...REQUEST,
        settings: SETTINGS,
      }, 400],
      // This is structurally valid, but conflicts with the broker-pinned
      // execution profile rather than being malformed.
      ["foreign scan account", {
        ...REQUEST, plan: { ...PLAN, scanAccountId: "111111111111" },
      }, 409],
      ["invalid snapshot ttl", {
        ...REQUEST, plan: { ...PLAN, summary: { snapshotTtlHours: 999 } },
      }, 400],
      ["duplicate volume", {
        ...REQUEST, plan: { ...PLAN, volumes: [...PLAN.volumes, ...PLAN.volumes] },
      }, 400],
    ];
    for (const [label, payload, expectedStatus] of cases) {
      const response = await signedRequest(
        baseUrl, secret, "POST", `/v1/agentless/scans/${RUN_ID}/execute`, payload,
      );
      assert.equal(response.status, expectedStatus, `${label} must be refused safely`);
    }
    // None of them claimed the run, so it is still untracked.
    const polled = await signedRequest(
      baseUrl, secret, "GET",
      `/v1/agentless/scans/${RUN_ID}?tenantId=${TENANT_ID}&connectionId=${CONNECTION_ID}`,
    );
    assert.equal(polled.status, 404, "a refused request must not leave a claimed run behind");
  });
});

test("an unsigned request never reaches the handler", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/agentless/scans/${RUN_ID}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REQUEST),
    });
    assert.ok(response.status === 401 || response.status === 403, `got ${response.status}`);
  });
});

test("an arbitrary resource id is rejected by the durable ledger before AWS deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-agentless-cleanup-route-"));
  const sharedSecret = randomBytes(32).toString("base64url");
  let authorizationChecks = 0;
  let recorded = false;
  const server = createLocalCollectorServer({
    sharedSecret,
    registryEncryptionKey: randomBytes(32).toString("base64url"),
    registryPath: join(directory, "connections.enc.json"),
    localJobStatePath: join(directory, "local-jobs.json"),
    mode: "fixture",
    allowLiveAws: false,
    principalArn: "arn:aws:iam::999988887777:role/SutraLocalCollector",
    hostedAgentlessCleanupSettings: SETTINGS,
    agentlessCleanupLedger: {
      authorize: async () => {
        authorizationChecks += 1;
        throw new RegistryStateError();
      },
      record: async () => { recorded = true; },
    },
    now: () => NOW,
  });
  try {
    const baseUrl = await listen(server);
    const response = await signedRequest(
      baseUrl,
      sharedSecret,
      "POST",
      "/v1/agentless/teardown-sweep",
      {
        tenantId: TENANT_ID,
        operationId: "job_teardown_1234",
        resources: [{
          connectionId: CONNECTION_ID,
          resourceId: "snap-0a1b2c3d4e5f6a7b8",
          resourceKind: "snapshot",
          accountScope: "sutra-scan-account",
          region: "ap-south-1",
        }],
      },
    );
    assert.equal(response.status, 409);
    assert.equal(authorizationChecks, 1);
    assert.equal(recorded, false, "an unowned identifier must never reach AWS or settlement");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("pre-approval exposes only the pinned plan profile and refuses execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-agentless-preapproval-"));
  const sharedSecret = randomBytes(32).toString("base64url");
  const server = createLocalCollectorServer({
    sharedSecret,
    registryEncryptionKey: randomBytes(32).toString("base64url"),
    registryPath: join(directory, "connections.enc.json"),
    localJobStatePath: join(directory, "local-jobs.json"),
    mode: "fixture",
    allowLiveAws: false,
    principalArn: "arn:aws:iam::999988887777:role/SutraLocalCollector",
    hostedAgentlessPlanProfile: {
      scanAccountId: SETTINGS.scanAccountId,
      kmsReencrypt: false,
    },
    now: () => NOW,
  });
  try {
    const baseUrl = await listen(server);
    const readiness = await signedRequest(
      baseUrl, sharedSecret, "GET", "/v1/agentless/readiness",
    );
    assert.equal(readiness.status, 200);
    assert.equal((readiness.value as { canPlan?: unknown }).canPlan, true);
    assert.equal((readiness.value as { canExecute?: unknown }).canExecute, false);
    const profile = await signedRequest(
      baseUrl, sharedSecret, "GET", "/v1/agentless/plan-profile",
    );
    assert.deepEqual(profile.value, {
      schema: "sutra.aws-agentless-plan-profile.v1",
      scanAccountId: SETTINGS.scanAccountId,
      kmsReencrypt: false,
    });
    const execute = await signedRequest(
      baseUrl,
      sharedSecret,
      "POST",
      `/v1/agentless/scans/${RUN_ID}/execute`,
      REQUEST,
    );
    assert.equal(execute.status, 503);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

async function signedRequest(
  baseUrl: string,
  sharedSecret: string,
  method: "GET" | "POST",
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
  const text = await response.text();
  return { status: response.status, value: text.length === 0 ? null : (JSON.parse(text) as unknown) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64url")).update(value, "utf8").digest("hex");
}
