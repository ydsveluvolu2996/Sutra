import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const {
  PilotServerError,
  runComputeOptimizerExportObjectChunkRead,
} = await import("../lib/pilot-server.ts");

const SECRET = Buffer.alloc(32, 7).toString("base64");
const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const PATH = `/v1/connections/${CONNECTION_ID}/compute-optimizer-export-object-chunk`;
const REQUEST = {
  tenantId: "tenant-object-reader",
  connectionId: CONNECTION_ID,
  jobId: "materialize-job",
  contractId: "co-object-use1-ec2",
  plannedJobId: "12345678-abcd-4321-aaaa-123456789012",
  region: "us-east-1",
  bucket: "customer-compute-optimizer-use1",
  key: "ec2-instance-recommendations/compute-optimizer/123456789012/" +
    "us-east-1-export.csv",
  offset: 0,
  maximumBytes: 4,
  versionId: null,
  ifMatch: null,
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
  const bytes = Buffer.from([1, 2, 3, 4]);
  return JSON.stringify({
    schema: "sutra.compute-optimizer-export-object-chunk.v1",
    tenantId: REQUEST.tenantId,
    connectionId: REQUEST.connectionId,
    jobId: REQUEST.jobId,
    contractId: REQUEST.contractId,
    plannedJobId: REQUEST.plannedJobId,
    region: REQUEST.region,
    bucket: REQUEST.bucket,
    key: REQUEST.key,
    offset: 0,
    totalBytes: 4,
    bytesRead: 4,
    complete: true,
    identity: { kind: "VERSION", versionId: "version-1", eTag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' },
    sha256: sha256(bytes),
    bodyBase64: bytes.toString("base64"),
  });
}

test("signed Compute Optimizer wrapper accepts only a response bound to path, nonce and body", async () => {
  const originalFetch = globalThis.fetch;
  let forgeBody = false;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `http://127.0.0.1:8788${PATH}`);
    assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    const nonce = headers.get("x-sutra-nonce");
    const timestamp = headers.get("x-sutra-timestamp");
    const signature = headers.get("x-sutra-signature");
    assert.ok(nonce);
    assert.ok(timestamp);
    assert.ok(signature);
    const requestBody = String(init?.body);
    assert.deepEqual(JSON.parse(requestBody), REQUEST);
    assert.equal(
      signature,
      hmac(`POST\n${PATH}\n${timestamp}\n${nonce}\n${sha256(requestBody)}`),
    );
    const authenticBody = responseBody();
    const deliveredBody = forgeBody
      ? authenticBody.replace('"totalBytes":4', '"totalBytes":5')
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
    const accepted = await runComputeOptimizerExportObjectChunkRead(REQUEST, context);
    assert.equal(accepted.schema, "sutra.compute-optimizer-export-object-chunk.v1");
    forgeBody = true;
    await assert.rejects(
      runComputeOptimizerExportObjectChunkRead(REQUEST, context),
      (error) => error instanceof PilotServerError
        && error.code === "BROKER_RESPONSE_INVALID",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
