import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const {
  PilotServerError,
  runComputeOptimizerMaterializationActivationManifest,
} = await import("../lib/pilot-server.ts");

const SECRET = Buffer.alloc(32, 13).toString("base64");
const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const ACCOUNT = "123456789012";
const PATH =
  `/v1/connections/${CONNECTION_ID}/compute-optimizer-materialization-activation-manifest`;
const REQUEST = {
  schema: "sutra.compute-optimizer-materialization-activation-manifest-request.v1",
  requestId: "activation-transport-request-1",
  tenantId: "tenant-activation-transport",
  connectionId: CONNECTION_ID,
  accountId: ACCOUNT,
  partition: "aws",
  requiredPermissionPackVersion: "standard-2026-08.5",
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

function manifest() {
  return {
    schema: "sutra.compute-optimizer-materialization-activation-manifest-response.v1",
    requestId: REQUEST.requestId,
    tenantId: REQUEST.tenantId,
    connectionId: REQUEST.connectionId,
    accountId: REQUEST.accountId,
    partition: REQUEST.partition,
    permissionPackVersion: REQUEST.requiredPermissionPackVersion,
    regions: [{
      region: "us-east-1",
      describeContractId: "co-source-us-east-1",
      launchContractId: "co-launch-us-east-1",
      objectReadContractId: "co-object-us-east-1",
      bucket: "sutra-compute-optimizer-us-east-1",
      basePrefix: "exports/us-east-1/",
      effectivePrefix: `exports/us-east-1/compute-optimizer/${ACCOUNT}/`,
    }],
  };
}

test("manifest transport signs the exact request and verifies the exact response", async () => {
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
    assert.equal(headers.get("x-sutra-signature"),
      hmac(`POST\n${PATH}\n${timestamp}\n${nonce}\n${sha256(requestBody)}`));
    const authenticBody = JSON.stringify(manifest());
    const deliveredBody = forgeBody
      ? authenticBody.replace("co-source-us-east-1", "forged-source")
      : authenticBody;
    return new Response(deliveredBody, { status: 200, headers: {
      "content-type": "application/json",
      "x-sutra-response-signature":
        hmac(`200\n${PATH}\n${nonce}\n${sha256(authenticBody)}`),
    } });
  };
  try {
    const context = { signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 20_000 };
    assert.deepEqual(
      await runComputeOptimizerMaterializationActivationManifest(REQUEST, context),
      manifest(),
    );
    forgeBody = true;
    await assert.rejects(
      runComputeOptimizerMaterializationActivationManifest(REQUEST, context),
      (error) => error instanceof PilotServerError
        && error.code === "BROKER_RESPONSE_INVALID",
    );
  } finally { globalThis.fetch = originalFetch; }
});

test("64 KiB ceiling rejects declared and streamed oversize responses before release", async () => {
  const originalFetch = globalThis.fetch;
  let declared = true;
  globalThis.fetch = async (_url, init) => {
    const nonce = new Headers(init?.headers).get("x-sutra-nonce");
    const body = "x".repeat(64 * 1024 + 1);
    return new Response(body, { status: 200, headers: {
      ...(declared ? { "content-length": String(body.length) } : {}),
      "x-sutra-response-signature": hmac(`200\n${PATH}\n${nonce}\n${sha256(body)}`),
    } });
  };
  try {
    const context = { signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 20_000 };
    await assert.rejects(
      runComputeOptimizerMaterializationActivationManifest(REQUEST, context),
      (error) => error instanceof PilotServerError
        && error.code === "BROKER_RESPONSE_INVALID",
    );
    declared = false;
    await assert.rejects(
      runComputeOptimizerMaterializationActivationManifest(REQUEST, context),
      (error) => error instanceof PilotServerError
        && error.code === "BROKER_RESPONSE_INVALID",
    );
  } finally { globalThis.fetch = originalFetch; }
});

test("deadline and abort stop the transport without releasing a response", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async (_url, init) => {
    fetches += 1;
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(
        new DOMException("aborted", "AbortError"),
      ), { once: true });
    });
  };
  try {
    await assert.rejects(
      runComputeOptimizerMaterializationActivationManifest(REQUEST, {
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() - 1,
      }),
      (error) => error instanceof PilotServerError && error.code === "REQUEST_TIMEOUT",
    );
    assert.equal(fetches, 0);

    const controller = new AbortController();
    const pending = runComputeOptimizerMaterializationActivationManifest(REQUEST, {
      signal: controller.signal,
      deadlineAtMs: Date.now() + 20_000,
    });
    controller.abort();
    await assert.rejects(pending,
      (error) => error instanceof PilotServerError && error.code === "BROKER_UNAVAILABLE");
    assert.equal(fetches, 1);
  } finally { globalThis.fetch = originalFetch; }
});
