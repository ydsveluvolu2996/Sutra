/** Replay-protected signed route for ADD-13 historical Price List collection. */
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { HostedRequestAuthenticationError, type HostedRequestAuthenticator } from "./hosted-request-auth.js";
import {
  PRICING_CHANGE_PROVIDER_ACTIONS,
  PRICING_CHANGE_PROVIDER_BOUNDS,
  PRICING_CHANGE_MATERIALIZATION_BOUNDS,
  PricingChangeProviderAdapterError,
  collectPricingChangeProviderEvidence,
  type PricingChangeProviderBinding,
  type PricingChangeProviderReader,
  type PricingChangeProviderRequest,
} from "./pricing-change-provider-adapter.js";
import type { AwsTemporaryCredentials } from "./types.js";

export const PRICING_CHANGE_PROVIDER_ROUTE = "/v1/finops/pricing-change-analysis/materialize";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const GENERATION = /^fbg_[a-f0-9]{64}$/u;
const COLLECTION = /^pca_[a-f0-9]{64}$/u;
const REQUEST = /^pcrq_[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{64}$/u;

export interface PricingChangeProviderRouteDependencies {
  readonly authenticator: HostedRequestAuthenticator;
  readonly loadBinding: (scope: PricingChangeProviderRequest["materialization"]["scope"]) => Promise<PricingChangeProviderBinding | null>;
  readonly assumeReadOnlySession: (input: { readonly binding: PricingChangeProviderBinding; readonly actions: typeof PRICING_CHANGE_PROVIDER_ACTIONS; readonly requestId: string; readonly signal: AbortSignal }) => Promise<{ readonly accountId: string; readonly partition: PricingChangeProviderBinding["partition"]; readonly credentials: AwsTemporaryCredentials }>;
  readonly reader: PricingChangeProviderReader;
  readonly now?: () => number;
}
export interface PricingChangeProviderRouteResponse { readonly status: number; readonly body: string; readonly headers: Readonly<Record<string, string>> }

function reject(): never { throw new Error("PRICING_CHANGE_PROVIDER_REQUEST_INVALID"); }
function exact(value: unknown, keys?: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject();
  if (keys !== undefined && JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) reject();
  return value as Readonly<Record<string, unknown>>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function sorted(values: unknown, validator: (item: string) => boolean, maximum: number): values is readonly string[] {
  return Array.isArray(values) && values.length > 0 && values.length <= maximum
    && values.every((item) => typeof item === "string" && validator(item))
    && JSON.stringify(values) === JSON.stringify([...new Set(values)].sort());
}
function header(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name]; if (typeof value !== "string") reject(); return value;
}
function parse(body: string): PricingChangeProviderRequest {
  if (Buffer.byteLength(body, "utf8") > PRICING_CHANGE_PROVIDER_BOUNDS.maximumRequestBytes) throw new PricingChangeProviderAdapterError("BOUND_REACHED");
  let raw: unknown; try { raw = JSON.parse(body); } catch { reject(); }
  const root = exact(raw, ["schemaVersion", "requestKey", "materialization", "cur2", "credentials", "actions", "deadlineAtIso"]);
  const materialization = exact(root.materialization, ["schemaVersion", "scope", "collectionId", "activeCur2", "boundary", "baselineEffectiveAt", "comparisonEffectiveAt", "historicalPriceList", "bounds", "deadlineAtIso"]);
  const scope = exact(materialization.scope, ["organizationId", "customerId", "connectionId"]);
  const active = exact(materialization.activeCur2, ["source", "scope", "partition", "exportName", "billingPeriod", "generationId", "manifestSha256", "generatedAtIso", "usagePeriodStartAt", "usagePeriodEndAt", "sourceFormat", "sourceVersion", "payerAccountIds", "linkedAccountIds", "regions", "coverage"]);
  const activeScope = exact(active.scope, ["organizationId", "customerId", "connectionId"]);
  const boundary = exact(materialization.boundary, ["scope", "partition", "payerAccountIds", "linkedAccountIds", "regions"]);
  const boundaryScope = exact(boundary.scope, ["orgId", "customerId", "connectionId"]);
  const cur2 = exact(root.cur2, ["schemaVersion", "scope", "exportName", "billingPeriod", "generationId", "manifestSha256", "generatedAtIso", "sourceFormat", "sourceVersion", "rowsExhausted", "sourceRowCount", "selectedUsageRowCount", "omittedRowCount", "rows"]);
  const cur2Scope = exact(cur2.scope, ["organizationId", "customerId", "connectionId"]);
  const coverage = exact(active.coverage, ["readPermissionsValidated", "manifestObjectCount", "processedObjectCount", "acceptedRowCount", "rejectedRowCount"]);
  const historical = exact(materialization.historicalPriceList, ["source", "operations", "fileFormat", "selectionAxes", "exactApplicabilityRequired", "tierAllocationRequiredForNonFlatRates"]);
  if (root.schemaVersion !== "sutra.pricing-change.provider-request.v1" || typeof root.requestKey !== "string" || !REQUEST.test(root.requestKey)
    || materialization.schemaVersion !== "sutra.pricing-change.materializer-request.v1" || typeof materialization.collectionId !== "string" || !COLLECTION.test(materialization.collectionId)
    || typeof scope.organizationId !== "string" || !ID.test(scope.organizationId) || typeof scope.customerId !== "string" || !ID.test(scope.customerId)
    || typeof scope.connectionId !== "string" || !CONNECTION.test(scope.connectionId) || !same(scope, activeScope) || !same(scope, cur2Scope)
    || boundaryScope.orgId !== scope.organizationId || boundaryScope.customerId !== scope.customerId || boundaryScope.connectionId !== scope.connectionId
    || active.source !== "ACTIVE_RECONCILED_CUR2_GENERATION" || typeof active.generationId !== "string" || !GENERATION.test(active.generationId)
    || typeof active.manifestSha256 !== "string" || !SHA.test(active.manifestSha256) || !["aws", "aws-cn", "aws-us-gov"].includes(String(active.partition))
    || boundary.partition !== active.partition || active.sourceFormat !== "aws-cur" || active.sourceVersion !== "2.0"
    || !sorted(active.payerAccountIds, (item) => ACCOUNT.test(item), 1_000) || !sorted(active.linkedAccountIds, (item) => ACCOUNT.test(item), 1_000)
    || !sorted(active.regions, (item) => /^(?:[a-z]{2}(?:-gov)?-[a-z]+-\d|GLOBAL)$/u.test(item), 50)
    || !same(active.payerAccountIds, boundary.payerAccountIds) || !same(active.linkedAccountIds, boundary.linkedAccountIds) || !same(active.regions, boundary.regions)
    || coverage.readPermissionsValidated !== true || ![coverage.manifestObjectCount, coverage.processedObjectCount, coverage.acceptedRowCount, coverage.rejectedRowCount].every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
    || coverage.manifestObjectCount !== coverage.processedObjectCount || coverage.rejectedRowCount !== 0
    || cur2.schemaVersion !== "sutra.pricing-change.cur2-artifact.v1" || cur2.generationId !== active.generationId || cur2.manifestSha256 !== active.manifestSha256
    || cur2.generatedAtIso !== active.generatedAtIso || cur2.sourceFormat !== "aws-cur" || cur2.sourceVersion !== "2.0" || cur2.rowsExhausted !== true
    || !Array.isArray(cur2.rows) || cur2.rows.length > PRICING_CHANGE_PROVIDER_BOUNDS.maximumSelectedUsageRows
    || cur2.selectedUsageRowCount !== cur2.rows.length || cur2.sourceRowCount !== coverage.acceptedRowCount
    || cur2.sourceRowCount !== Number(cur2.selectedUsageRowCount) + Number(cur2.omittedRowCount)
    || historical.source !== "AWS_PRICE_LIST_BULK_API_HISTORICAL_FILES" || !same(historical.operations, PRICING_CHANGE_PROVIDER_ACTIONS)
    || historical.fileFormat !== "json" || historical.selectionAxes !== "ACTIVE_CUR2_SERVICE_REGION_CURRENCY_ONLY"
    || historical.exactApplicabilityRequired !== true || historical.tierAllocationRequiredForNonFlatRates !== true
    || !same(materialization.bounds, PRICING_CHANGE_MATERIALIZATION_BOUNDS)
    || root.credentials !== "SERVER_OWNED_TRUST_ROLE_SESSION" || !same(root.actions, PRICING_CHANGE_PROVIDER_ACTIONS)
    || root.deadlineAtIso !== materialization.deadlineAtIso || typeof root.deadlineAtIso !== "string" || !Number.isFinite(Date.parse(root.deadlineAtIso))) reject();
  const seen = new Set<string>();
  for (const rawRow of cur2.rows) {
    const row = exact(rawRow, ["usageId", "payerAccountId", "linkedAccountId", "serviceCode", "region", "usageStartAt", "usageEndAt", "lineItemType", "termType", "currency", "usageUnit", "usageQuantity", "applicabilityAttributes"]);
    const quantity = exact(row.usageQuantity, ["numerator", "denominator"]);
    const attributes = row.applicabilityAttributes;
    if (typeof row.usageId !== "string" || !ID.test(row.usageId) || seen.has(row.usageId) || typeof row.payerAccountId !== "string"
      || !active.payerAccountIds.includes(row.payerAccountId) || typeof row.linkedAccountId !== "string" || !active.linkedAccountIds.includes(row.linkedAccountId)
      || typeof row.serviceCode !== "string" || !ID.test(row.serviceCode) || typeof row.region !== "string" || !active.regions.includes(row.region)
      || !["USAGE", "DISCOUNTED_USAGE", "SAVINGS_PLAN_COVERED_USAGE"].includes(String(row.lineItemType))
      || !["ON_DEMAND", "RESERVED", "SAVINGS_PLAN"].includes(String(row.termType)) || typeof row.currency !== "string" || !/^[A-Z]{3}$/u.test(row.currency)
      || typeof row.usageUnit !== "string" || row.usageUnit.length < 1 || row.usageUnit.length > 64
      || typeof quantity.numerator !== "string" || !/^[1-9]\d{0,59}$/u.test(quantity.numerator)
      || typeof quantity.denominator !== "string" || !/^[1-9]\d{0,59}$/u.test(quantity.denominator)
      || !Array.isArray(attributes) || attributes.length < 1 || attributes.length > 32) reject();
    const parsedAttributes = attributes.map((item) => { const attribute = exact(item, ["name", "value"]);
      if (typeof attribute.name !== "string" || attribute.name.length < 1 || attribute.name.length > 128
        || typeof attribute.value !== "string" || attribute.value.length < 1 || attribute.value.length > 512) reject();
      return { name: attribute.name, value: attribute.value }; });
    if (new Set(parsedAttributes.map((item) => item.name)).size !== parsedAttributes.length
      || canonical(parsedAttributes) !== canonical([...parsedAttributes].sort((left, right) => left.name.localeCompare(right.name)))) reject();
    seen.add(row.usageId);
  }
  const typed = raw as PricingChangeProviderRequest;
  if (typed.requestKey !== `pcrq_${sha(canonical({ materialization: typed.materialization, cur2: typed.cur2 }))}`) reject();
  return typed;
}
async function response(dependencies: PricingChangeProviderRouteDependencies, status: number, nonce: string, payload: Readonly<Record<string, unknown>>): Promise<PricingChangeProviderRouteResponse> {
  const body = JSON.stringify(payload), signature = await dependencies.authenticator.responseSignature(status, PRICING_CHANGE_PROVIDER_ROUTE, nonce, body);
  return { status, body, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "x-sutra-key-id": signature.keyId, "x-sutra-signature": signature.signature } };
}

export async function handlePricingChangeProviderRoute(input: { readonly method: string; readonly path: string; readonly headers: IncomingHttpHeaders;
  readonly body: string; readonly dependencies: PricingChangeProviderRouteDependencies; readonly signal: AbortSignal }): Promise<PricingChangeProviderRouteResponse> {
  let nonce = "";
  try {
    if (input.method.toUpperCase() !== "POST" || input.path !== PRICING_CHANGE_PROVIDER_ROUTE || input.signal.aborted) reject();
    const authenticated = await input.dependencies.authenticator.verify({ method: input.method, path: input.path, headers: input.headers, body: input.body });
    nonce = authenticated.nonce; const request = parse(input.body), scope = request.materialization.scope;
    if (header(input.headers, "x-sutra-tenant-id") !== scope.organizationId || header(input.headers, "x-sutra-customer-id") !== scope.customerId
      || header(input.headers, "x-sutra-connection-id") !== scope.connectionId || header(input.headers, "x-sutra-request-id") !== request.requestKey) reject();
    const binding = await input.dependencies.loadBinding(scope);
    if (binding === null) return response(input.dependencies, 409, nonce, { code: "PRICING_CHANGE_PROVIDER_BINDING_UNAVAILABLE", state: "unavailable" });
    const session = await input.dependencies.assumeReadOnlySession({ binding, actions: PRICING_CHANGE_PROVIDER_ACTIONS, requestId: request.requestKey, signal: input.signal });
    if (session.accountId !== binding.accountId || session.partition !== binding.partition) reject();
    const capture = await collectPricingChangeProviderEvidence({ request, binding, credentials: session.credentials,
      reader: input.dependencies.reader, signal: input.signal, ...(input.dependencies.now === undefined ? {} : { now: input.dependencies.now }) });
    return response(input.dependencies, 200, nonce, { schemaVersion: "sutra.pricing-change.provider-response.v1", requestKey: request.requestKey,
      requestBodySha256: sha(input.body), captureBodySha256: sha(canonical(capture)), capture });
  } catch (error) {
    const code = error instanceof HostedRequestAuthenticationError ? "AUTHENTICATION_FAILED"
      : error instanceof PricingChangeProviderAdapterError ? error.code : input.signal.aborted ? "ABORTED" : "REQUEST_REJECTED";
    const status = code === "AUTHENTICATION_FAILED" ? 401 : code === "BOUND_REACHED" ? 413 : code === "ABORTED" ? 408 : 400;
    return response(input.dependencies, status, nonce, { code, state: "failed", message: "Pricing Change provider request did not complete" });
  }
}
