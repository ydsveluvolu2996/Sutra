import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "../lib/canonical-json.ts";
import { createPricingChangeSignedBroker, PRICING_CHANGE_BROKER_PATH, PricingChangeSignedBrokerError } from "../lib/finops-pricing-change-signed-broker.ts";
import type { PricingChangeMaterializerRequest } from "../lib/finops-pricing-change-materialization-job.ts";

const account = "111122223333", scope = { organizationId: "org_signed_pricing", customerId: "customer_signed_pricing", connectionId: `conn_${"a".repeat(32)}` };
const boundaryScope = { orgId: scope.organizationId, customerId: scope.customerId, connectionId: scope.connectionId };
const activeCur2 = { source: "ACTIVE_RECONCILED_CUR2_GENERATION" as const, scope, partition: "aws" as const, exportName: "cur2-main", billingPeriod: "2026-06",
  generationId: `fbg_${"b".repeat(64)}`, manifestSha256: "c".repeat(64), generatedAtIso: "2026-07-01T01:00:00.000Z",
  usagePeriodStartAt: "2026-06-01T00:00:00.000Z", usagePeriodEndAt: "2026-07-01T00:00:00.000Z", sourceFormat: "aws-cur" as const,
  sourceVersion: "2.0" as const, payerAccountIds: [account], linkedAccountIds: [account], regions: ["us-east-1"],
  coverage: { readPermissionsValidated: true, manifestObjectCount: 1, processedObjectCount: 1, acceptedRowCount: 0, rejectedRowCount: 0 } };
const materialization: PricingChangeMaterializerRequest = { schemaVersion: "sutra.pricing-change.materializer-request.v1", scope,
  collectionId: `pca_${"d".repeat(64)}`, activeCur2, boundary: { scope: boundaryScope, partition: "aws", payerAccountIds: [account], linkedAccountIds: [account], regions: ["us-east-1"] },
  baselineEffectiveAt: "2026-01-15T00:00:00.000Z", comparisonEffectiveAt: "2026-07-15T00:00:00.000Z",
  historicalPriceList: { source: "AWS_PRICE_LIST_BULK_API_HISTORICAL_FILES", operations: ["pricing:ListPriceLists", "pricing:GetPriceListFileUrl"],
    fileFormat: "json", selectionAxes: "ACTIVE_CUR2_SERVICE_REGION_CURRENCY_ONLY", exactApplicabilityRequired: true, tierAllocationRequiredForNonFlatRates: true },
  bounds: { maximumCaptureBytes: 67108864, maximumResponseBytes: 8388608, maximumDurationMs: 900000, maximumAccounts: 1000,
    maximumRegions: 50, maximumUsageRecords: 250000, maximumCatalogSnapshots: 20000, maximumCatalogTerms: 500000,
    maximumCatalogCoverageRecords: 40000, maximumAttributes: 32, maximumGroupsInResponse: 5000, maximumExclusionGroupsInResponse: 2000,
    maximumTextLength: 512, maximumCur2GenerationAgeHours: 48, maximumCatalogRetrievalAgeHours: 744, maximumUsageHistoryDays: 400, maximumDecimalScale: 12 },
  deadlineAtIso: "2026-08-02T00:15:00.000Z" };
const cur2 = { schemaVersion: "sutra.pricing-change.cur2-artifact.v1" as const, scope, exportName: activeCur2.exportName, billingPeriod: activeCur2.billingPeriod,
  generationId: activeCur2.generationId, manifestSha256: activeCur2.manifestSha256, generatedAtIso: activeCur2.generatedAtIso,
  sourceFormat: "aws-cur" as const, sourceVersion: "2.0" as const, rowsExhausted: true as const, sourceRowCount: 0,
  selectedUsageRowCount: 0, omittedRowCount: 0, rows: [] };
const capture = { schemaVersion: "sutra.pricing-change.capture.v1" as const, scope: boundaryScope, partition: "aws" as const,
  payerAccountIds: [account], linkedAccountIds: [account], regions: ["us-east-1"], collectionId: materialization.collectionId,
  startedAt: "2026-08-02T00:00:00.000Z", completedAt: "2026-08-02T00:00:01.000Z", usagePeriodStartAt: activeCur2.usagePeriodStartAt,
  usagePeriodEndAt: activeCur2.usagePeriodEndAt, baselineEffectiveAt: materialization.baselineEffectiveAt, comparisonEffectiveAt: materialization.comparisonEffectiveAt,
  activeCur2GenerationId: activeCur2.generationId, activeCur2GeneratedAt: activeCur2.generatedAtIso, activeCur2ManifestSha256: activeCur2.manifestSha256,
  cur2Coverage: { status: "SUCCEEDED" as const, readPermissionsValidated: true, manifestObjectCount: 1, processedObjectCount: 1, errorCode: null },
  catalogCoverage: [], usage: [], catalogSnapshots: [], catalogTerms: [] };
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function fixture(tamper = false) {
  const app = generateKeyPairSync("ed25519"), broker = generateKeyPairSync("ed25519"), brokerKeyId = "pricing-broker-v1";
  const signing = { clientKeyId: "pricing-app-v1", clientPrivateKey: app.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    brokerKeyId, brokerPublicKey: broker.publicKey.export({ format: "der", type: "spki" }).toString("base64url") };
  const fetcher: typeof fetch = async (_url, init) => {
    const body = String(init?.body), headers = init?.headers as Readonly<Record<string, string>>, request = JSON.parse(body) as { requestKey: string };
    const responseBody = JSON.stringify({ schemaVersion: "sutra.pricing-change.provider-response.v1", requestKey: request.requestKey,
      requestBodySha256: hash(body), captureBodySha256: tamper ? "0".repeat(64) : hash(canonicalJson(capture)), capture });
    const signature = sign(null, Buffer.from(["SUTRA-BROKER-APP-V1", "200", PRICING_CHANGE_BROKER_PATH, headers["x-sutra-nonce"], brokerKeyId, hash(responseBody)].join("\n"), "utf8"), broker.privateKey).toString("base64url");
    return new Response(responseBody, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "x-sutra-key-id": brokerKeyId, "x-sutra-signature": signature } });
  };
  return createPricingChangeSignedBroker({ brokerOrigin: "https://collector.example.com", signing, readCur2: async () => cur2,
    fetcher, now: () => Date.parse("2026-08-02T00:00:00.000Z"), nonce: () => "abcdefghijklmnopqrstuvwxyz123456" });
}

test("signed broker binds exact CUR2 bytes, request hash, response signature, and capture hash", async () => {
  const result = await fixture().collect(materialization, new AbortController().signal);
  assert.equal(result.collectionId, materialization.collectionId);
});
test("signed broker rejects a signed envelope whose capture hash was substituted", async () => {
  await assert.rejects(fixture(true).collect(materialization, new AbortController().signal),
    (error: unknown) => error instanceof PricingChangeSignedBrokerError && error.code === "RESPONSE_REJECTED");
});
