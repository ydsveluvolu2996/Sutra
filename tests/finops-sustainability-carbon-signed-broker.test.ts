import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "../lib/canonical-json.ts";
import { createSustainabilityCarbonSignedBroker, SUSTAINABILITY_CARBON_BROKER_PATH, SustainabilityCarbonSignedBrokerError } from "../lib/finops-sustainability-carbon-signed-broker.ts";
import type { SustainabilityCarbonRuntimeRequest } from "../lib/finops-sustainability-carbon-runtime-binding.ts";

const connectionId = `conn_${"a".repeat(32)}`, accountId = "111122223333";
const scope = { orgId: "org_signed", customerId: "customer_signed", connectionId, accountId, partition: "aws" as const };
const request = { schemaVersion: "sutra.sustainability-carbon-runtime-request.v1", requestId: `scr_${"b".repeat(64)}`, expectedCaptureId: `sustainability_${"b".repeat(64)}`, scheduledWindow: "2026-08-02T00:00:00.000Z", scope, allowedUsageAccountIds: [accountId], credentials: "SERVER_OWNED_TRUST_ROLE_SESSION", maximumDurationMs: 20 * 60 * 1_000 } as unknown as SustainabilityCarbonRuntimeRequest;
const capture = { schemaVersion: "sutra.sustainability-carbon.v1" as const, scope, captureId: request.expectedCaptureId, startedAtIso: "2026-08-02T00:00:00.000Z", completedAtIso: "2026-08-02T00:01:00.000Z", allowedUsageAccountIds: [accountId], configuration: { cur2Configured: true, carbonExportConfigured: true, carbonExportAccessValidated: true }, proxyEvidence: null, carbonEvidence: null };
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function fixture(tamperCaptureHash = false) {
  const app = generateKeyPairSync("ed25519"), broker = generateKeyPairSync("ed25519"), brokerKeyId = "sustainability-broker-v1";
  const signing = { clientKeyId: "sustainability-app-v1", clientPrivateKey: app.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"), brokerKeyId, brokerPublicKey: broker.publicKey.export({ format: "der", type: "spki" }).toString("base64url") };
  const fetcher: typeof fetch = async (_url, init) => {
    const body = String(init?.body), headers = init?.headers as Readonly<Record<string, string>>, nonce = headers["x-sutra-nonce"]!;
    const responseBody = JSON.stringify({ schemaVersion: "sutra.sustainability-carbon-materializer-response.v1", requestBodySha256: hash(body), capture, captureBodySha256: tamperCaptureHash ? "0".repeat(64) : hash(canonicalJson(capture)), directApiComparator: null, separation: { exportIsAuthoritativeHistory: true, comparatorPersistedAsExport: false, comparatorMayReplaceExportState: false, proxyConvertedToCarbon: false, carbonAllocatedToCur2: false } });
    const signature = sign(null, Buffer.from(["SUTRA-BROKER-APP-V1", "200", SUSTAINABILITY_CARBON_BROKER_PATH, nonce, brokerKeyId, hash(responseBody)].join("\n"), "utf8"), broker.privateKey).toString("base64url");
    return new Response(responseBody, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "x-sutra-key-id": brokerKeyId, "x-sutra-signature": signature } });
  };
  return createSustainabilityCarbonSignedBroker({ brokerOrigin: "https://collector.example.com", signing, fetcher, now: () => Date.parse("2026-08-02T00:01:00.000Z"), nonce: () => "abcdefghijklmnopqrstuvwxyz123456" });
}

test("app-side materializer accepts only exact signed and normalized capture bytes", async () => {
  const result = await fixture().collect(request, new AbortController().signal);
  assert.equal(result.capture.captureId, request.expectedCaptureId);
  assert.equal(result.verification.authentication, "ED25519_RESPONSE_SIGNATURE_VERIFIED");
  assert.equal(result.verification.captureBodySha256, hash(canonicalJson(capture)));
});

test("app-side materializer rejects a signed envelope with a substituted capture hash", async () => {
  await assert.rejects(fixture(true).collect(request, new AbortController().signal),
    (error: unknown) => error instanceof SustainabilityCarbonSignedBrokerError && error.code === "RESPONSE_INVALID");
});
