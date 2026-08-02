import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { GetPriceListFileUrlCommand, ListPriceListsCommand } from "@aws-sdk/client-pricing";
import { createPricingChangeAwsSdkReader, type PricingChangePricingClient } from "../src/pricing-change-aws-sdk-reader.js";
import { collectPricingChangeProviderEvidence, PRICING_CHANGE_MATERIALIZATION_BOUNDS, PRICING_CHANGE_PROVIDER_ACTIONS, type PricingChangeProviderBinding, type PricingChangeProviderRequest } from "../src/pricing-change-provider-adapter.js";
import { handlePricingChangeProviderRoute, PRICING_CHANGE_PROVIDER_ROUTE } from "../src/pricing-change-provider-route.js";
import { HostedRequestAuthenticator } from "../src/hosted-request-auth.js";

const scope = { organizationId: "org_pricing", customerId: "customer_pricing", connectionId: `conn_${"a".repeat(32)}` };
const boundaryScope = { orgId: scope.organizationId, customerId: scope.customerId, connectionId: scope.connectionId };
const generationId = `fbg_${"b".repeat(64)}`, manifestSha256 = "c".repeat(64), account = "111122223333";
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const activeCur2 = { source: "ACTIVE_RECONCILED_CUR2_GENERATION" as const, scope, partition: "aws" as const, exportName: "cur2-main", billingPeriod: "2026-06",
  generationId, manifestSha256, generatedAtIso: "2026-07-01T01:00:00.000Z", usagePeriodStartAt: "2026-06-01T00:00:00.000Z",
  usagePeriodEndAt: "2026-07-01T00:00:00.000Z", sourceFormat: "aws-cur" as const, sourceVersion: "2.0" as const,
  payerAccountIds: [account], linkedAccountIds: [account], regions: ["us-east-1"],
  coverage: { readPermissionsValidated: true, manifestObjectCount: 1, processedObjectCount: 1, acceptedRowCount: 1, rejectedRowCount: 0 } };
const row = { usageId: "line-1", payerAccountId: account, linkedAccountId: account, serviceCode: "AmazonEC2", region: "us-east-1",
  usageStartAt: "2026-06-01T00:00:00.000Z", usageEndAt: "2026-06-01T01:00:00.000Z", lineItemType: "USAGE" as const,
  termType: "ON_DEMAND" as const, currency: "USD", usageUnit: "Hrs", usageQuantity: { numerator: "1", denominator: "1" },
  applicabilityAttributes: [{ name: "operation", value: "RunInstances" }, { name: "productFamily", value: "Compute Instance" },
    { name: "servicecode", value: "AmazonEC2" }, { name: "usagetype", value: "BoxUsage" }] };
const materialization = { schemaVersion: "sutra.pricing-change.materializer-request.v1" as const, scope, collectionId: `pca_${"d".repeat(64)}`,
  activeCur2, boundary: { scope: boundaryScope, partition: "aws" as const, payerAccountIds: [account], linkedAccountIds: [account], regions: ["us-east-1"] },
  baselineEffectiveAt: "2026-01-15T00:00:00.000Z", comparisonEffectiveAt: "2026-07-15T00:00:00.000Z",
  historicalPriceList: { source: "AWS_PRICE_LIST_BULK_API_HISTORICAL_FILES" as const, operations: PRICING_CHANGE_PROVIDER_ACTIONS,
    fileFormat: "json" as const, selectionAxes: "ACTIVE_CUR2_SERVICE_REGION_CURRENCY_ONLY" as const,
    exactApplicabilityRequired: true as const, tierAllocationRequiredForNonFlatRates: true as const }, bounds: PRICING_CHANGE_MATERIALIZATION_BOUNDS, deadlineAtIso: "2026-08-02T00:15:00.000Z" };
const cur2 = { schemaVersion: "sutra.pricing-change.cur2-artifact.v1" as const, scope, exportName: activeCur2.exportName, billingPeriod: activeCur2.billingPeriod,
  generationId, manifestSha256, generatedAtIso: activeCur2.generatedAtIso, sourceFormat: "aws-cur" as const, sourceVersion: "2.0" as const,
  rowsExhausted: true as const, sourceRowCount: 1, selectedUsageRowCount: 1, omittedRowCount: 0, rows: [row] };
function request(): PricingChangeProviderRequest {
  const requestKey = `pcrq_${hash(canonical({ materialization, cur2 }))}`;
  return { schemaVersion: "sutra.pricing-change.provider-request.v1", requestKey, materialization, cur2,
    credentials: "SERVER_OWNED_TRUST_ROLE_SESSION", actions: PRICING_CHANGE_PROVIDER_ACTIONS, deadlineAtIso: materialization.deadlineAtIso };
}
const binding: PricingChangeProviderBinding = { schemaVersion: "sutra.pricing-change-provider-binding.v1", ...scope, accountId: account,
  partition: "aws", permissionPackVersion: "standard-2026-08.17", pricingEndpointRegion: "us-east-1" };
const credentials = { accessKeyId: "ASIAEXAMPLE", secretAccessKey: "secret", sessionToken: "token", expiration: new Date("2026-08-02T01:00:00.000Z") };
function priceFile(version: string, effectiveDate: string, price: string, duplicate = false) {
  const rate = { rateCode: "SKU1.JRT.RATE", description: "hour", beginRange: "0", endRange: "Inf", unit: "Hrs", pricePerUnit: { USD: price }, appliesTo: [] };
  return { formatVersion: "v1.0", disclaimer: "informational", offerCode: "AmazonEC2", version,
  publicationDate: effectiveDate, products: { SKU1: { sku: "SKU1", productFamily: "Compute Instance", attributes: { servicecode: "AmazonEC2", operation: "RunInstances", usagetype: "BoxUsage" } } },
  terms: { OnDemand: { SKU1: { JRT: { offerTermCode: "JRT", sku: "SKU1", effectiveDate,
    priceDimensions: { "SKU1.JRT.RATE": rate, ...(duplicate ? { "SKU1.JRT.RATE2": { ...rate, rateCode: "SKU1.JRT.RATE2" } } : {}) }, termAttributes: {} } } } } };
}
function reader(duplicate = false) {
  const files = new Map<string, unknown>();
  const client: PricingChangePricingClient = { send: async (command) => {
    if (command instanceof ListPriceListsCommand) {
      const baseline = (command.input.EffectiveDate?.getTime() ?? 0) < Date.parse("2026-06-01T00:00:00.000Z"), version = baseline ? "20260101000000" : "20260701000000";
      return { PriceLists: [{ PriceListArn: `arn:aws:pricing:::price-list/AmazonEC2/USD/${version}/us-east-1`, RegionCode: "us-east-1", CurrencyCode: "USD", FileFormats: ["json"] }] };
    }
    if (command instanceof GetPriceListFileUrlCommand) {
      const arn = command.input.PriceListArn!, version = arn.split("/").at(-2)!; const url = `https://pricing.us-east-1.amazonaws.com/${version}.json`;
      files.set(url, priceFile(version, version.startsWith("202601") ? "2026-01-01T00:00:00.000Z" : "2026-07-01T00:00:00.000Z", version.startsWith("202601") ? "0.10" : "0.20", duplicate));
      return { Url: url };
    }
    throw new Error("unexpected command");
  } };
  const fetcher: typeof fetch = async (url) => { const value = files.get(String(url)); if (value === undefined) throw new Error("unknown file");
    const body = JSON.stringify(value);
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } }); };
  return createPricingChangeAwsSdkReader({ clientFactory: () => client, fetcher });
}

test("historical SDK reader produces exact baseline/comparison matches and never bills with current-price substitution", async () => {
  let now = Date.parse("2026-08-02T00:00:00.000Z");
  const capture = await collectPricingChangeProviderEvidence({ request: request(), binding, credentials, reader: reader(),
    signal: new AbortController().signal, now: () => now++ }) as { readonly usage: readonly { readonly baselinePriceId: string | null; readonly comparisonPriceId: string | null }[];
      readonly catalogSnapshots: readonly { readonly catalogVersion: string }[] };
  assert.equal(capture.usage.length, 1); const usage = capture.usage[0]; assert.ok(usage);
  assert.ok(usage.baselinePriceId !== null); assert.match(usage.baselinePriceId, /^price_[a-f0-9]{64}$/u);
  assert.ok(usage.comparisonPriceId !== null); assert.match(usage.comparisonPriceId, /^price_[a-f0-9]{64}$/u);
  assert.notEqual(usage.baselinePriceId, usage.comparisonPriceId);
  assert.deepEqual(capture.catalogSnapshots.map((item) => item.catalogVersion), ["20260101000000", "20260701000000"]);
});

test("ambiguous product evidence remains unmatched instead of selecting a neighboring SKU", async () => {
  let now = Date.parse("2026-08-02T00:00:00.000Z");
  const capture = await collectPricingChangeProviderEvidence({ request: request(), binding, credentials, reader: reader(true),
    signal: new AbortController().signal, now: () => now++ }) as { readonly usage: readonly { readonly baselinePriceId: string | null; readonly comparisonPriceId: string | null }[] };
  const usage = capture.usage[0]; assert.ok(usage); assert.equal(usage.baselinePriceId, null); assert.equal(usage.comparisonPriceId, null);
});

test("strict signed route authenticates scope once and rejects replay", async () => {
  const app = generateKeyPairSync("ed25519"), broker = generateKeyPairSync("ed25519"), consumed = new Set<string>();
  const now = Date.parse("2026-08-02T00:00:00.000Z"), authenticator = new HostedRequestAuthenticator({
    clientPublicKeys: { "app-v1": app.publicKey.export({ format: "der", type: "spki" }).toString("base64url") }, brokerKeyId: "broker-v1",
    brokerPrivateKey: broker.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    replayStore: { consume: async (key) => !consumed.has(key) && (consumed.add(key), true) }, now: () => now });
  const body = JSON.stringify(request()), timestamp = String(now), nonce = "abcdefghijklmnopqrstuvwxyz123456", keyId = "app-v1";
  const signature = sign(null, Buffer.from(["SUTRA-APP-BROKER-V1", "POST", PRICING_CHANGE_PROVIDER_ROUTE, timestamp, nonce, keyId, hash(body)].join("\n"), "utf8"), app.privateKey).toString("base64url");
  const headers = { "x-sutra-timestamp": timestamp, "x-sutra-nonce": nonce, "x-sutra-key-id": keyId, "x-sutra-signature": signature,
    "x-sutra-tenant-id": scope.organizationId, "x-sutra-customer-id": scope.customerId, "x-sutra-connection-id": scope.connectionId, "x-sutra-request-id": request().requestKey };
  const input = { method: "POST", path: PRICING_CHANGE_PROVIDER_ROUTE, headers, body, dependencies: { authenticator, loadBinding: async () => binding,
    assumeReadOnlySession: async () => ({ accountId: account, partition: "aws" as const, credentials }), reader: reader(), now: () => now }, signal: new AbortController().signal };
  const accepted = await handlePricingChangeProviderRoute(input); assert.equal(accepted.status, 200); assert.match(accepted.headers["x-sutra-signature"]!, /^[A-Za-z0-9_-]{86}$/u);
  const replay = await handlePricingChangeProviderRoute(input); assert.equal(replay.status, 401); assert.doesNotMatch(replay.body, /secret|token|ASIAEXAMPLE/u);
});
