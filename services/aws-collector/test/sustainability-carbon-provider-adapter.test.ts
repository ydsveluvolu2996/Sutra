import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  SUSTAINABILITY_CARBON_COLUMNS,
  SUSTAINABILITY_PROVIDER_BOUNDS,
  SustainabilityProviderAdapterError,
  collectSustainabilityProviderEvidence,
  type SustainabilityProviderBinding,
  type SustainabilityProviderReader,
  type SustainabilityProviderRequest,
} from "../src/sustainability-carbon-provider-adapter.js";
import { HostedRequestAuthenticator } from "../src/hosted-request-auth.js";
import { handleSustainabilityCarbonRoute, SUSTAINABILITY_PROVIDER_ROUTE } from "../src/sustainability-carbon-route.js";

const account = "111122223333"; const connectionId = `conn_${"a".repeat(32)}`;
const request: SustainabilityProviderRequest = {
  schemaVersion: "sutra.sustainability-carbon-runtime-request.v1", requestId: `scr_${"b".repeat(64)}`,
  expectedCaptureId: `sustainability_${"b".repeat(64)}`, scheduledWindow: "2026-08-02T00:00:00.000Z",
  scope: { orgId: "org_sustainability", customerId: "customer_sustainability", connectionId, accountId: account, partition: "aws" },
  allowedUsageAccountIds: [account], credentials: "SERVER_OWNED_TRUST_ROLE_SESSION",
  channels: {
    proxy: { source: "AWS_CUR2_ACTIVE_GENERATION", state: "ACTIVE_RECONCILED", generationId: `fbg_${"c".repeat(64)}`, manifestSha256: "d".repeat(64), dataThroughAtIso: "2026-08-02T00:00:00.000Z", rowsExhausted: true, interpretation: "RESOURCE_USE_PROXY_NOT_CARBON", conversionToMtco2e: false },
    providerCarbon: { source: "AWS_SUSTAINABILITY_CARBON_DATA_EXPORT", tableName: "CARBON_EMISSIONS", exportName: "sutra_carbon", exportArn: `arn:aws:bcm-data-exports:us-east-1:${account}:export/sutra_carbon`, exportRegion: "us-east-1", bucket: "sutra-carbon-bucket", prefix: "tenant/carbon/", expectedBucketOwner: account, generationId: `fbg_${"e".repeat(64)}`, manifestSha256: "f".repeat(64), schemaColumns: SUSTAINABILITY_CARBON_COLUMNS, publicationKind: "MONTHLY", publishedAtIso: "2026-08-01T00:00:00.000Z", expectedUsagePeriods: ["2026-06"], interpretation: "PROVIDER_ESTIMATE_MTCO2E_NOT_WORKLOAD_ATTRIBUTION", allocateToCur2ResourcesOrTags: false, keepLbmAndMbmSeparate: true, keepTotalsAndScopesSeparate: true },
  },
  objectReads: { current: ["s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject"], versioned: ["s3:GetObjectVersion"], enforceExactPrefix: true, enforceExpectedBucketOwner: true },
  maximumDurationMs: SUSTAINABILITY_PROVIDER_BOUNDS.maximumDurationMs,
};
const binding: SustainabilityProviderBinding = { schemaVersion: "sutra.sustainability-provider-binding.v1", orgId: request.scope.orgId, customerId: request.scope.customerId, connectionId, permissionPackVersion: "standard-2026-08.15", bucketRegion: "us-east-1", kmsKeyArn: null, directApiComparator: "READ_ONLY_SEPARATE", dimensionContractVersion: "sutra.sustainability-proxy-dimensions.v2", regionReference: { sourceUri: "https://example.invalid/pinned-region-reference", sourceVersion: "cid-f9e36d88", sha256: "1".repeat(64) } };
const credentials = { accessKeyId: "ASIAEXAMPLE", secretAccessKey: "secret", sessionToken: "token", expiration: new Date("2026-08-02T02:00:00.000Z") };
const objectKey = "tenant/carbon/model_version=v3.0.1/usage_period=2026-06/report.csv.gz";
function reader() { return {
  readActiveCur2: async () => ({ generationId: request.channels.proxy.generationId, manifestSha256: request.channels.proxy.manifestSha256, dataThroughAtIso: request.channels.proxy.dataThroughAtIso, rowsExhausted: true, rows: [] }),
  readCarbonExport: async () => ({ bucket: request.channels.providerCarbon.bucket, prefix: request.channels.providerCarbon.prefix, expectedBucketOwner: account, exportArn: request.channels.providerCarbon.exportArn, generationId: request.channels.providerCarbon.generationId, manifestSha256: request.channels.providerCarbon.manifestSha256, publishedAtIso: request.channels.providerCarbon.publishedAtIso, objectsExhausted: true, objects: [{ key: objectKey, eTag: "etag", versionId: "v1", sha256: "2".repeat(64), sizeBytes: 0, bucket: request.channels.providerCarbon.bucket }], rowsExhausted: true, periods: [{ usagePeriod: "2026-06", selectedModelVersion: "v3.0.1", deliveryState: "DELIVERED_EMPTY", objectKeys: [objectKey], complete: true }], rows: [] }),
  readDirectComparator: async () => ({ source: "AWS_SUSTAINABILITY_DIRECT_API" as const, observedAtIso: "2026-08-02T00:00:00.000Z", requestSha256: "3".repeat(64), pagesExhausted: true, pageCount: 1, rows: [] }),
}; }

test("authoritative export capture and direct API comparator remain structurally separate", async () => {
  let now = Date.parse("2026-08-02T00:01:00.000Z");
  const result = await collectSustainabilityProviderEvidence({ request, binding, credentials, reader: reader(), signal: new AbortController().signal, now: () => now++ });
  assert.equal(result.capture.carbonEvidence.source, "AWS_SUSTAINABILITY_CARBON_DATA_EXPORT");
  assert.equal(result.directApiComparator?.source, "AWS_SUSTAINABILITY_DIRECT_API");
  assert.equal(Object.hasOwn(result.capture, "directApiComparator"), false);
  assert.equal(result.separation.comparatorPersistedAsExport, false);
  assert.equal(result.separation.proxyConvertedToCarbon, false);
});

test("scope/prefix substitution and non-exhausted comparator fail closed", async () => {
  await assert.rejects(collectSustainabilityProviderEvidence({ request: { ...request, channels: { ...request.channels, providerCarbon: { ...request.channels.providerCarbon, prefix: "other/" } } }, binding, credentials, reader: reader(), signal: new AbortController().signal }), (error: unknown) => error instanceof SustainabilityProviderAdapterError && error.code === "PROVIDER_RESPONSE_INVALID");
  const forged = reader(); forged.readDirectComparator = async () => ({ source: "AWS_SUSTAINABILITY_DIRECT_API" as const, observedAtIso: "2026-08-02T00:00:00.000Z", requestSha256: "3".repeat(64), pagesExhausted: false, pageCount: 1, rows: [] });
  await assert.rejects(collectSustainabilityProviderEvidence({ request, binding, credentials, reader: forged, signal: new AbortController().signal }), (error: unknown) => error instanceof SustainabilityProviderAdapterError && error.code === "PROVIDER_RESPONSE_INVALID");
});

test("separate comparator is byte bounded before it enters the signed response", async () => {
  const oversized: SustainabilityProviderReader = reader();
  oversized.readDirectComparator = async () => ({
    source: "AWS_SUSTAINABILITY_DIRECT_API" as const,
    observedAtIso: "2026-08-02T00:00:00.000Z",
    requestSha256: "3".repeat(64),
    pagesExhausted: true,
    pageCount: 1,
    rows: [{ payload: "x".repeat(SUSTAINABILITY_PROVIDER_BOUNDS.maximumComparatorBytes) }],
  });
  await assert.rejects(
    collectSustainabilityProviderEvidence({ request, binding, credentials, reader: oversized, signal: new AbortController().signal }),
    (error: unknown) => error instanceof SustainabilityProviderAdapterError && error.code === "BOUND_REACHED",
  );
});

test("strict signed route authenticates once, signs the response, and rejects replay", async () => {
  const app = generateKeyPairSync("ed25519"), broker = generateKeyPairSync("ed25519"), consumed = new Set<string>();
  const now = Date.parse("2026-08-02T00:01:00.000Z");
  const authenticator = new HostedRequestAuthenticator({ clientPublicKeys: { "app-v1": app.publicKey.export({ format: "der", type: "spki" }).toString("base64url") }, brokerKeyId: "broker-v1", brokerPrivateKey: broker.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"), replayStore: { consume: async (key) => !consumed.has(key) && (consumed.add(key), true) }, now: () => now });
  const body = JSON.stringify(request), timestamp = String(now), nonce = "abcdefghijklmnopqrstuvwxyz123456", keyId = "app-v1";
  const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex");
  const signature = sign(null, Buffer.from(["SUTRA-APP-BROKER-V1", "POST", SUSTAINABILITY_PROVIDER_ROUTE, timestamp, nonce, keyId, bodySha256].join("\n"), "utf8"), app.privateKey).toString("base64url");
  const input = { method: "POST", path: SUSTAINABILITY_PROVIDER_ROUTE, headers: { "x-sutra-timestamp": timestamp, "x-sutra-nonce": nonce, "x-sutra-key-id": keyId, "x-sutra-signature": signature }, body, dependencies: { authenticator, loadBinding: async () => binding, assumeRole: async () => credentials, reader: reader(), now: () => now }, signal: new AbortController().signal };
  const accepted = await handleSustainabilityCarbonRoute(input);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers["cache-control"], "no-store");
  assert.match(accepted.headers["x-sutra-signature"] ?? "", /^[A-Za-z0-9_-]{86}$/u);
  assert.equal(JSON.parse(accepted.body).separation.comparatorPersistedAsExport, false);
  const replay = await handleSustainabilityCarbonRoute(input);
  assert.equal(replay.status, 401);
  assert.equal(JSON.parse(replay.body).code, "AUTHENTICATION_FAILED");
  assert.doesNotMatch(replay.body, /secret|token|ASIAEXAMPLE/u);
});
