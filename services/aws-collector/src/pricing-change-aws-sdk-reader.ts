/** Bounded AWS SDK + bulk-file reader for historical Pricing Change evidence. */
import { createHash } from "node:crypto";
import {
  GetPriceListFileUrlCommand,
  ListPriceListsCommand,
  PricingClient,
  type PriceList,
} from "@aws-sdk/client-pricing";
import {
  PRICING_CHANGE_PROVIDER_BOUNDS,
  type PricingChangeProviderReader,
  type PricingChangeProviderRow,
} from "./pricing-change-provider-adapter.js";
import type { AwsTemporaryCredentials } from "./types.js";

const DECIMAL = /^(?:0|[1-9]\d{0,30})(?:\.\d{1,12})?$/u;
const SAFE = /^[^\u0000-\u001f\u007f<>]{1,512}$/u;
const PRICE_LIST_HOST = /(?:^|\.)amazonaws\.com$/u;
const LIST_URL = "https://api.pricing.us-east-1.amazonaws.com/";

interface CatalogProduct { readonly sku: string; readonly productFamily: string | null; readonly attributes: Readonly<Record<string, string>> }
interface CatalogTerm {
  readonly priceId: string; readonly snapshotId: string; readonly serviceCode: string; readonly region: string;
  readonly currency: string; readonly productSku: string; readonly offerTermCode: string; readonly rateCode: string;
  readonly termType: "ON_DEMAND" | "RESERVED"; readonly usageUnit: string;
  readonly applicabilityAttributes: readonly { readonly name: string; readonly value: string }[];
  readonly beginRange: { readonly numerator: string; readonly denominator: string };
  readonly endRange: { readonly numerator: string; readonly denominator: string } | null;
  readonly unitPrice: { readonly numerator: string; readonly denominator: string };
  readonly effectiveFromAt: string; readonly effectiveToAt: null;
}
interface CatalogSnapshot {
  readonly snapshotId: string; readonly role: "BASELINE" | "COMPARISON"; readonly partition: "aws" | "aws-cn" | "aws-us-gov";
  readonly serviceCode: string; readonly region: string; readonly currency: string; readonly requestedEffectiveAt: string;
  readonly catalogEffectiveAt: string; readonly catalogPublicationAt: string; readonly catalogVersion: string;
  readonly priceListArn: string; readonly fileFormat: "json";
  readonly listEvidence: Evidence; readonly fileEvidence: Evidence;
}
interface Evidence { readonly id: string; readonly kind: "CUR2_DATA_EXPORT" | "AWS_PRICE_LIST_API" | "AWS_PRICE_LIST_FILE";
  readonly operation: string; readonly url: string; readonly retrievedAt: string; readonly effectiveAt: string; readonly sha256: string }
interface PriceListReference { readonly arn: string; readonly region: string; readonly currency: string; readonly formats: readonly string[] }

export interface PricingChangePricingClient {
  send(command: ListPriceListsCommand | GetPriceListFileUrlCommand, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown>;
}
export interface PricingChangeAwsSdkReaderOptions {
  readonly clientFactory?: (credentials: AwsTemporaryCredentials) => PricingChangePricingClient;
  readonly fetcher?: typeof fetch;
}

function reject(): never { throw new Error("PRICING_CHANGE_PROVIDER_RESPONSE_INVALID"); }
function exact(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject();
  return value as Readonly<Record<string, unknown>>;
}
function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.length > maximum || !SAFE.test(value)) reject();
  return value;
}
function timestamp(value: unknown): string {
  const raw = value instanceof Date ? value.toISOString() : text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(raw) || !Number.isFinite(Date.parse(raw))) reject();
  return new Date(Date.parse(raw)).toISOString();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function identifier(prefix: string, value: unknown): string { return `${prefix}_${digest(canonical(value))}`; }
function rational(value: string): { readonly numerator: string; readonly denominator: string } {
  if (!DECIMAL.test(value)) reject();
  const [whole, fraction = ""] = value.split(".");
  let numerator = BigInt(`${whole}${fraction}`), denominator = BigInt(10) ** BigInt(fraction.length);
  if (numerator === BigInt(0)) return { numerator: "0", denominator: "1" };
  while (denominator % BigInt(2) === BigInt(0) && numerator % BigInt(2) === BigInt(0)) { denominator /= BigInt(2); numerator /= BigInt(2); }
  while (denominator % BigInt(5) === BigInt(0) && numerator % BigInt(5) === BigInt(0)) { denominator /= BigInt(5); numerator /= BigInt(5); }
  return { numerator: numerator.toString(), denominator: denominator.toString() };
}
function stableUrl(value: string): string {
  let url: URL; try { url = new URL(value); } catch { reject(); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || !PRICE_LIST_HOST.test(url.hostname)) reject();
  url.search = ""; url.hash = ""; return url.toString();
}
function pricingClient(credentials: AwsTemporaryCredentials): PricingChangePricingClient {
  return new PricingClient({ region: "us-east-1", credentials, maxAttempts: 4 });
}
function attributes(product: CatalogProduct): readonly { readonly name: string; readonly value: string }[] {
  const selected = [
    { name: "servicecode", value: product.attributes.servicecode },
    { name: "operation", value: product.attributes.operation },
    { name: "productFamily", value: product.productFamily ?? undefined },
    { name: "usagetype", value: product.attributes.usagetype },
  ].filter((item): item is { name: string; value: string } => typeof item.value === "string" && item.value.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
  if (selected.length < 1 || selected.some((item) => item.value.length > 512)) reject();
  return selected;
}
function products(value: unknown): ReadonlyMap<string, CatalogProduct> {
  const root = exact(value), result = new Map<string, CatalogProduct>();
  for (const [key, raw] of Object.entries(root)) {
    const item = exact(raw), sku = text(item.sku, 256), rawAttributes = exact(item.attributes);
    if (sku !== key || result.has(sku)) reject();
    const parsed: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, child] of Object.entries(rawAttributes)) if (typeof child === "string" && child.length > 0 && child.length <= 512) parsed[name] = child;
    result.set(sku, { sku, productFamily: typeof item.productFamily === "string" && item.productFamily.length > 0 ? text(item.productFamily) : null, attributes: parsed });
  }
  return result;
}
function parseTerms(input: {
  readonly rawTerms: unknown; readonly productMap: ReadonlyMap<string, CatalogProduct>; readonly snapshotId: string;
  readonly serviceCode: string; readonly region: string; readonly currency: string;
}): CatalogTerm[] {
  const all = exact(input.rawTerms), output: CatalogTerm[] = [];
  for (const [awsType, rawBySku] of Object.entries(all)) {
    const termType = awsType === "OnDemand" ? "ON_DEMAND" : awsType === "Reserved" ? "RESERVED" : null;
    if (termType === null) continue;
    for (const [sku, rawOffers] of Object.entries(exact(rawBySku))) {
      const product = input.productMap.get(sku); if (product === undefined) reject();
      for (const [offerCodeKey, rawOffer] of Object.entries(exact(rawOffers))) {
        const offer = exact(rawOffer), offerTermCode = text(offer.offerTermCode, 256);
        if (offerTermCode !== offerCodeKey || offer.sku !== sku || (termType === "RESERVED" && Object.keys(exact(offer.termAttributes ?? {})).length > 0)) continue;
        const effectiveFromAt = timestamp(offer.effectiveDate);
        for (const [rateCodeKey, rawRate] of Object.entries(exact(offer.priceDimensions))) {
          const rate = exact(rawRate), rateCode = text(rate.rateCode, 256), usageUnit = text(rate.unit, 64);
          if (rateCode !== rateCodeKey || !Array.isArray(rate.appliesTo) || rate.appliesTo.length > 0) continue;
          const price = exact(rate.pricePerUnit)[input.currency]; if (typeof price !== "string") continue;
          const begin = text(rate.beginRange, 64), end = text(rate.endRange, 64);
          const applicabilityAttributes = attributes(product);
          const priceId = identifier("price", { snapshotId: input.snapshotId, sku, offerTermCode, rateCode });
          output.push({ priceId, snapshotId: input.snapshotId, serviceCode: input.serviceCode, region: input.region,
            currency: input.currency, productSku: sku, offerTermCode, rateCode, termType, usageUnit,
            applicabilityAttributes, beginRange: rational(begin), endRange: end === "Inf" ? null : rational(end),
            unitPrice: rational(price), effectiveFromAt, effectiveToAt: null });
        }
      }
    }
  }
  return output;
}
async function body(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (response.status !== 200 || (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > PRICING_CHANGE_PROVIDER_BOUNDS.maximumSingleFileBytes)) || response.body === null) reject();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  while (true) { const item = await reader.read(); if (item.done) break; total += item.value.byteLength;
    if (total > PRICING_CHANGE_PROVIDER_BOUNDS.maximumSingleFileBytes) { await reader.cancel(); reject(); } chunks.push(item.value); }
  if (total < 2) reject(); const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes;
}
function reference(value: PriceList): PriceListReference {
  const arn = text(value.PriceListArn, 1_024), region = text(value.RegionCode, 128), currency = text(value.CurrencyCode, 3);
  const formats = [...new Set((value.FileFormats ?? []).map((item) => text(item, 32)))].sort();
  if (!formats.includes("json")) reject();
  return { arn, region, currency, formats };
}
function catalogEffectiveAt(rawTerms: unknown, requestedEffectiveAt: string): string {
  const candidates: string[] = [];
  for (const rawBySku of Object.values(exact(rawTerms))) for (const rawOffers of Object.values(exact(rawBySku))) {
    for (const rawOffer of Object.values(exact(rawOffers))) {
      const effective = timestamp(exact(rawOffer).effectiveDate);
      if (Date.parse(effective) <= Date.parse(requestedEffectiveAt)) candidates.push(effective);
    }
  }
  if (candidates.length < 1) reject();
  return candidates.sort().at(-1)!;
}
async function list(input: { readonly client: PricingChangePricingClient; readonly serviceCode: string; readonly region: string;
  readonly currency: string; readonly effectiveAt: string; readonly signal: AbortSignal }): Promise<{ readonly references: readonly PriceListReference[]; readonly hash: string }> {
  const records: PriceListReference[] = []; let token: string | undefined; const seen = new Set<string>();
  const responsePages: unknown[] = [];
  for (let page = 0; page < PRICING_CHANGE_PROVIDER_BOUNDS.maximumListPagesPerAxis; page += 1) {
    const response = exact(await input.client.send(new ListPriceListsCommand({ ServiceCode: input.serviceCode, CurrencyCode: input.currency,
      EffectiveDate: new Date(input.effectiveAt), RegionCode: input.region, ...(token === undefined ? {} : { NextToken: token }) }), { abortSignal: input.signal }));
    responsePages.push(response);
    if (!Array.isArray(response.PriceLists)) reject(); for (const item of response.PriceLists) records.push(reference(item as PriceList));
    const next = response.NextToken;
    if (next === undefined || next === null || next === "") { token = undefined; break; }
    if (typeof next !== "string" || next.length > 4_096 || next === token || seen.has(next)) reject();
    seen.add(next); token = next; if (page === PRICING_CHANGE_PROVIDER_BOUNDS.maximumListPagesPerAxis - 1) reject();
  }
  const references = [...records].sort((left, right) => left.arn.localeCompare(right.arn));
  if (new Set(references.map((item) => item.arn)).size !== references.length) reject();
  return { references, hash: digest(canonical(responsePages)) };
}
function match(row: PricingChangeProviderRow, role: "BASELINE" | "COMPARISON", snapshots: readonly CatalogSnapshot[], terms: readonly CatalogTerm[]): string | null {
  if (row.termType === "SAVINGS_PLAN") return null;
  const snapshotIds = new Set(snapshots.filter((item) => item.role === role && item.serviceCode === row.serviceCode
    && item.region === row.region && item.currency === row.currency).map((item) => item.snapshotId));
  const matches = terms.filter((item) => snapshotIds.has(item.snapshotId) && item.serviceCode === row.serviceCode
    && item.region === row.region && item.currency === row.currency && item.termType === row.termType
    && item.usageUnit === row.usageUnit && canonical(item.applicabilityAttributes) === canonical(row.applicabilityAttributes));
  return matches.length === 1 ? matches[0]!.priceId : null;
}

export function createPricingChangeAwsSdkReader(options: PricingChangeAwsSdkReaderOptions = {}): PricingChangeProviderReader {
  const fetcher = options.fetcher ?? fetch;
  const reader: PricingChangeProviderReader = { collect: async (input) => {
    const { request, credentials, signal, now } = input;
    if (request.materialization.activeCur2.partition !== "aws") reject();
    const client = options.clientFactory?.(credentials) ?? pricingClient(credentials);
    const started = now(), snapshots: CatalogSnapshot[] = [], terms: CatalogTerm[] = [], coverage: unknown[] = [];
    const axes = [...new Map<string, { readonly serviceCode: string; readonly region: string; readonly currency: string }>(
      request.cur2.rows.map((row: PricingChangeProviderRow) => [`${row.serviceCode}\0${row.region}\0${row.currency}`, { serviceCode: row.serviceCode, region: row.region, currency: row.currency }]),
    ).values()]
      .sort((a, b) => canonical(a).localeCompare(canonical(b)));
    if (axes.length > PRICING_CHANGE_PROVIDER_BOUNDS.maximumAxes) reject();
    let downloaded = 0;
    for (const role of ["BASELINE", "COMPARISON"] as const) {
      const requestedEffectiveAt = role === "BASELINE" ? request.materialization.baselineEffectiveAt : request.materialization.comparisonEffectiveAt;
      for (const axis of axes) {
        const listedAt = new Date(now()).toISOString(), listed = await list({ client, ...axis, effectiveAt: requestedEffectiveAt, signal });
        let processed = 0;
        for (const ref of listed.references) {
          if (ref.region !== axis.region || ref.currency !== axis.currency
            || snapshots.length >= PRICING_CHANGE_PROVIDER_BOUNDS.maximumPriceListFiles) reject();
          const response = exact(await client.send(new GetPriceListFileUrlCommand({ PriceListArn: ref.arn, FileFormat: "json" }), { abortSignal: signal }));
          const rawUrl = text(response.Url, 4_096), stable = stableUrl(rawUrl);
          const bytes = await body(await fetcher(rawUrl, { method: "GET", redirect: "error", signal }));
          downloaded += bytes.byteLength; if (downloaded > PRICING_CHANGE_PROVIDER_BOUNDS.maximumDownloadedBytes) reject();
          let file: unknown; try { file = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { reject(); }
          const root = exact(file), version = text(root.version, 128), publication = timestamp(root.publicationDate);
          const effective = catalogEffectiveAt(root.terms, requestedEffectiveAt);
          if (!ref.arn.endsWith(`/${axis.serviceCode}/${axis.currency}/${version}/${axis.region}`)) reject();
          const snapshotId = identifier("pls", { role, arn: ref.arn, fileSha256: digest(bytes) });
          const listEvidence: Evidence = { id: identifier("ple", { role, axis, requestedEffectiveAt, hash: listed.hash }), kind: "AWS_PRICE_LIST_API",
            operation: "pricing:ListPriceLists", url: LIST_URL, retrievedAt: listedAt, effectiveAt: requestedEffectiveAt, sha256: listed.hash };
          const fileEvidence: Evidence = { id: identifier("ple", { snapshotId, stable }), kind: "AWS_PRICE_LIST_FILE",
            operation: "pricing:GetPriceListFileUrl", url: stable, retrievedAt: new Date(now()).toISOString(), effectiveAt: effective, sha256: digest(bytes) };
          const snapshot: CatalogSnapshot = { snapshotId, role, partition: request.materialization.activeCur2.partition,
            serviceCode: axis.serviceCode, region: axis.region, currency: axis.currency, requestedEffectiveAt,
            catalogEffectiveAt: effective, catalogPublicationAt: publication, catalogVersion: version,
            priceListArn: ref.arn, fileFormat: "json", listEvidence, fileEvidence };
          snapshots.push(snapshot);
          const parsedTerms = parseTerms({ rawTerms: root.terms, productMap: products(root.products), snapshotId,
            serviceCode: axis.serviceCode, region: axis.region, currency: axis.currency });
          if (terms.length + parsedTerms.length > PRICING_CHANGE_PROVIDER_BOUNDS.maximumCatalogTerms) reject();
          terms.push(...parsedTerms); processed += 1;
        }
        coverage.push({ role, ...axis, status: "SUCCEEDED", readPermissionsValidated: true,
          priceListCount: listed.references.length, processedPriceListCount: processed, errorCode: null });
      }
    }
    const completed = now(); if (!Number.isSafeInteger(started) || !Number.isSafeInteger(completed) || completed < started
      || completed - started > PRICING_CHANGE_PROVIDER_BOUNDS.maximumDurationMs) reject();
    const curEvidence: Evidence = { id: identifier("ple", { generationId: request.cur2.generationId, manifestSha256: request.cur2.manifestSha256 }),
      kind: "CUR2_DATA_EXPORT", operation: "AWS_DATA_EXPORTS_CUR2",
      url: "https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-cur2.html",
      retrievedAt: request.cur2.generatedAtIso, effectiveAt: request.materialization.activeCur2.usagePeriodStartAt,
      sha256: request.cur2.manifestSha256 };
    const usage = request.cur2.rows.map((row) => ({ ...row, generationId: request.cur2.generationId,
      baselinePriceId: match(row, "BASELINE", snapshots, terms), comparisonPriceId: match(row, "COMPARISON", snapshots, terms), source: curEvidence }));
    return Object.freeze({ schemaVersion: "sutra.pricing-change.capture.v1", scope: request.materialization.boundary.scope,
      partition: request.materialization.activeCur2.partition, payerAccountIds: request.materialization.activeCur2.payerAccountIds,
      linkedAccountIds: request.materialization.activeCur2.linkedAccountIds, regions: request.materialization.activeCur2.regions,
      collectionId: request.materialization.collectionId, startedAt: new Date(started).toISOString(), completedAt: new Date(completed).toISOString(),
      usagePeriodStartAt: request.materialization.activeCur2.usagePeriodStartAt, usagePeriodEndAt: request.materialization.activeCur2.usagePeriodEndAt,
      baselineEffectiveAt: request.materialization.baselineEffectiveAt, comparisonEffectiveAt: request.materialization.comparisonEffectiveAt,
      activeCur2GenerationId: request.cur2.generationId, activeCur2GeneratedAt: request.cur2.generatedAtIso,
      activeCur2ManifestSha256: request.cur2.manifestSha256,
      cur2Coverage: { status: "SUCCEEDED", readPermissionsValidated: true,
        manifestObjectCount: request.materialization.activeCur2.coverage.manifestObjectCount,
        processedObjectCount: request.materialization.activeCur2.coverage.processedObjectCount, errorCode: null },
      catalogCoverage: coverage, usage, catalogSnapshots: snapshots.sort((a, b) => a.snapshotId.localeCompare(b.snapshotId)),
      catalogTerms: terms.sort((a, b) => a.priceId.localeCompare(b.priceId)) });
  } };
  return Object.freeze(reader);
}
