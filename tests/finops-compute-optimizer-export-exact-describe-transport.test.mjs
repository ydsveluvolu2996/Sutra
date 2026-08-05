import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const {
  PilotServerError,
  runComputeOptimizerExportExactDescribe,
} = await import("../lib/pilot-server.ts");

const SECRET = Buffer.alloc(32, 9).toString("base64");
const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const PATH =
  `/v1/connections/${CONNECTION_ID}/compute-optimizer-export-exact-describe`;
const OBJECT_KEY =
  "compute-optimizer/123456789012/us-east-1-2026-08-02T000000Z-provider-job-1.csv";
const REQUEST = {
  schema: "sutra.compute-optimizer-export-exact-describe-request.v1",
  tenantId: "tenant-exact-transport",
  connectionId: CONNECTION_ID,
  collectionJobId: "fresh-read-job",
  contractId: "compute-optimizer-export-describe-v1",
  accountId: "123456789012",
  partition: "aws",
  region: "us-east-1",
  plannedJobs: [{
    targetId: `coelt_${"1".repeat(64)}`,
    plannedJobId: "provider-job-1",
    exportFamily: "EC2_INSTANCE",
    providerResourceType: "Ec2Instance",
    requestSha256: "a".repeat(64),
    bucket: "customer-compute-optimizer-use1",
    objectKey: OBJECT_KEY,
    metadataKey: `${OBJECT_KEY.slice(0, -4)}-metadata.json`,
  }],
};

cloudflare.env.SUTRA_LOCAL_MODE = "true";
cloudflare.env.SUTRA_CONNECTION_ENCRYPTION_KEY = "A".repeat(43);
cloudflare.env.SUTRA_BROKER_SHARED_SECRET = SECRET;
cloudflare.env.SUTRA_BROKER_URL = "http://127.0.0.1:8788";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(value) {
  return createHmac("sha256", Buffer.from(SECRET, "base64"))
    .update(value, "utf8").digest("hex");
}

function responseBody() {
  const planned = REQUEST.plannedJobs[0];
  return JSON.stringify({
    schema: "sutra.compute-optimizer-export-exact-describe-response.v1",
    tenantId: REQUEST.tenantId,
    connectionId: REQUEST.connectionId,
    collectionJobId: REQUEST.collectionJobId,
    contractId: REQUEST.contractId,
    accountId: REQUEST.accountId,
    partition: REQUEST.partition,
    region: REQUEST.region,
    observedAtIso: "2026-08-02T12:00:00.000Z",
    jobs: [{
      ...planned,
      jobId: planned.plannedJobId,
      status: "COMPLETE",
      creationTimestampIso: "2026-08-01T12:00:00.000Z",
      lastUpdatedTimestampIso: "2026-08-01T12:30:00.000Z",
      destination: {
        bucket: planned.bucket,
        objectKey: planned.objectKey,
        metadataKey: planned.metadataKey,
      },
    }],
  });
}

test("exact Describe wrapper verifies request and response signatures before release", async () => {
  const originalFetch = globalThis.fetch;
  let forgeBody = false;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `http://127.0.0.1:8788${PATH}`);
    assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    const nonce = headers.get("x-sutra-nonce");
    const timestamp = headers.get("x-sutra-timestamp");
    assert.ok(nonce);
    assert.ok(timestamp);
    const requestBody = String(init?.body);
    assert.deepEqual(JSON.parse(requestBody), REQUEST);
    assert.equal(
      headers.get("x-sutra-signature"),
      hmac(`POST\n${PATH}\n${timestamp}\n${nonce}\n${sha256(requestBody)}`),
    );
    const authenticBody = responseBody();
    const deliveredBody = forgeBody
      ? authenticBody.replace('"region":"us-east-1"', '"region":"us-west-2"')
      : authenticBody;
    return new Response(deliveredBody, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-sutra-response-signature": hmac(
          `200\n${PATH}\n${nonce}\n${sha256(authenticBody)}`,
        ),
      },
    });
  };
  try {
    const context = {
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 30_000,
    };
    const accepted = await runComputeOptimizerExportExactDescribe(REQUEST, context);
    assert.equal(accepted.schema,
      "sutra.compute-optimizer-export-exact-describe-response.v1");
    forgeBody = true;
    await assert.rejects(
      runComputeOptimizerExportExactDescribe(REQUEST, context),
      (error) => error instanceof PilotServerError
        && error.code === "BROKER_RESPONSE_INVALID",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
