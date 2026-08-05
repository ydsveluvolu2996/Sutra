import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const { PilotServerError, runComputeOptimizerExportLaunch } =
  await import("../lib/pilot-server.ts");

const SECRET = Buffer.alloc(32, 11).toString("base64");
const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const PATH = `/v1/connections/${CONNECTION_ID}/compute-optimizer-export-launch`;
const ATTEMPT = {
  schemaVersion: "sutra.compute-optimizer-export-launch-attempt.v1",
  scope: { orgId: "org_launch_transport", customerId: "customer_launch_transport",
    connectionId: CONNECTION_ID },
  requesterAccountId: "111122223333",
  partition: "aws",
  region: "us-east-1",
  scheduledWindow: "2026-08-02T00:00:00.000Z",
  targets: [],
  requestBatchId: `coelb_${"b".repeat(64)}`,
  sealedAtIso: "2026-08-02T12:00:00.000Z",
  attemptNumber: 1,
  launchAttemptId: `coela_${"c".repeat(64)}`,
  contentSha256: "c".repeat(64),
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

test("launch wrapper signs the sealed attempt and rejects a forged response body", async () => {
  const originalFetch = globalThis.fetch;
  let forgeBody = false;
  let fetches = 0;
  globalThis.fetch = async (url, init) => {
    fetches += 1;
    assert.equal(url, `http://127.0.0.1:8788${PATH}`);
    assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    const nonce = headers.get("x-sutra-nonce");
    const timestamp = headers.get("x-sutra-timestamp");
    assert.ok(nonce);
    assert.ok(timestamp);
    const requestBody = String(init?.body);
    assert.deepEqual(JSON.parse(requestBody), ATTEMPT);
    assert.equal(headers.get("x-sutra-signature"),
      hmac(`POST\n${PATH}\n${timestamp}\n${nonce}\n${sha256(requestBody)}`));
    const authenticBody = JSON.stringify({ schemaVersion:
      "sutra.compute-optimizer-export-launch-execution.v1", status: "COMPLETE" });
    const deliveredBody = forgeBody
      ? authenticBody.replace('"COMPLETE"', '"PARTIAL"')
      : authenticBody;
    return new Response(deliveredBody, { status: 200, headers: {
      "content-type": "application/json",
      "x-sutra-response-signature": hmac(`200\n${PATH}\n${nonce}\n${sha256(authenticBody)}`),
    } });
  };
  try {
    const context = { signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 30_000 };
    assert.equal((await runComputeOptimizerExportLaunch(ATTEMPT, context)).status, "COMPLETE");
    forgeBody = true;
    await assert.rejects(runComputeOptimizerExportLaunch(ATTEMPT, context),
      (error) => error instanceof PilotServerError && error.code === "BROKER_RESPONSE_INVALID");
    await assert.rejects(runComputeOptimizerExportLaunch(ATTEMPT, {
      signal: new AbortController().signal, deadlineAtMs: Date.now() - 1,
    }), (error) => error instanceof PilotServerError && error.code === "REQUEST_TIMEOUT");
    assert.equal(fetches, 2);
  } finally { globalThis.fetch = originalFetch; }
});
