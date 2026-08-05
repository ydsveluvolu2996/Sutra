/**
 * Credential-owning ADV-04 collection orchestration.
 *
 * Service-specific SDK calls live behind `ExtendedSupportAwsReader`; this
 * boundary owns fan-out, deadlines, token/page ceilings, scope checks,
 * deterministic ordering and capture sizing. Raw credentials and raw provider
 * diagnostics never enter the returned evidence capture.
 */
import { createHash } from "node:crypto";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;

export const EXTENDED_SUPPORT_PROVIDER_OPERATIONS = Object.freeze([
  "eks:ListClusters",
  "eks:DescribeCluster",
  "eks:DescribeClusterVersions",
  "rds:DescribeDBInstances",
  "rds:DescribeDBClusters",
  "rds:DescribeDBMajorEngineVersions",
  "rds:DescribeOrderableDBInstanceOptions",
  "es:ListDomainNames",
  "es:DescribeDomain",
  "es:DescribeDomains",
  "elasticache:DescribeCacheClusters",
  "elasticache:DescribeReplicationGroups",
  "elasticache:DescribeCacheEngineVersions",
  "pricing:GetProducts",
] as const);

export const EXTENDED_SUPPORT_PROVIDER_SESSION_ACTIONS = Object.freeze([
  "sts:GetCallerIdentity",
  ...EXTENDED_SUPPORT_PROVIDER_OPERATIONS,
] as const);

export const EXTENDED_SUPPORT_PROVIDER_BOUNDS = Object.freeze({
  maximumDurationMs: 15 * 60 * 1_000,
  maximumCaptureBytes: 32 * 1_024 * 1_024,
  maximumAccounts: 1_000,
  maximumRegions: 50,
  maximumPagesPerAccountRegion: 2_000,
  maximumRecordsPerPage: 1_000,
  maximumObservations: 50_000,
  maximumCalendarEntries: 2_000,
  maximumRates: 10_000,
  maximumObservedCharges: 100_000,
} as const);

export interface ExtendedSupportProviderBoundary {
  readonly scope: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
  };
  readonly managementAccountId: string;
  readonly partition: "aws" | "aws-cn" | "aws-us-gov";
  readonly accountIds: readonly string[];
  readonly regions: readonly string[];
}

export type ExtendedSupportProviderService =
  | "EKS" | "RDS" | "AURORA" | "OPENSEARCH" | "ELASTICACHE";

export interface ExtendedSupportProviderPage {
  readonly schemaVersion: "sutra.extended-support-provider-page.v1";
  readonly accountId: string;
  readonly region: string;
  readonly pageNumber: number;
  readonly finalPage: boolean;
  readonly observations: readonly unknown[];
  readonly calendars: readonly unknown[];
  readonly rates: readonly unknown[];
}

export interface ExtendedSupportProviderRegionCoverage {
  readonly service: ExtendedSupportProviderService;
  readonly status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  readonly readPermissionsValidated: boolean;
  readonly errorCode: string | null;
}

export interface ExtendedSupportProviderRegionResult {
  readonly pages: AsyncIterable<ExtendedSupportProviderPage>;
  readonly coverage: Promise<readonly ExtendedSupportProviderRegionCoverage[]>;
}

export interface ExtendedSupportProviderSupplement {
  readonly schemaVersion: "sutra.extended-support-provider-supplement.v1";
  readonly scope: ExtendedSupportProviderBoundary["scope"];
  readonly calendars: readonly unknown[];
  readonly rates: readonly unknown[];
  readonly observedCharges: readonly unknown[];
}

export interface ExtendedSupportAwsReader {
  collectRegion(input: {
    readonly boundary: ExtendedSupportProviderBoundary;
    readonly accountId: string;
    readonly region: string;
    readonly operations: typeof EXTENDED_SUPPORT_PROVIDER_OPERATIONS;
    readonly signal: AbortSignal;
  }): Promise<ExtendedSupportProviderRegionResult>;
  collectSupplement(input: {
    readonly boundary: ExtendedSupportProviderBoundary;
    readonly observedResourceKeys: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<ExtendedSupportProviderSupplement>;
}

export interface ExtendedSupportProviderCapture {
  readonly schemaVersion: "sutra.extended-support-projection.v1";
  readonly scope: ExtendedSupportProviderBoundary["scope"];
  readonly managementAccountId: string;
  readonly partition: ExtendedSupportProviderBoundary["partition"];
  readonly accountIds: readonly string[];
  readonly regions: readonly string[];
  readonly collectionId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly coverage: readonly {
    readonly service: ExtendedSupportProviderService;
    readonly status: "SUCCEEDED" | "PARTIAL" | "FAILED";
    readonly readPermissionsValidated: boolean;
    readonly accountIds: readonly string[];
    readonly regions: readonly string[];
    readonly recordCount: number;
    readonly errorCode: string | null;
  }[];
  readonly observations: readonly unknown[];
  readonly calendars: readonly unknown[];
  readonly rates: readonly unknown[];
  readonly observedCharges: readonly unknown[];
}

export class ExtendedSupportProviderAdapterError extends Error {
  public readonly code:
    | "INVALID_REQUEST" | "PROVIDER_RESPONSE_INVALID" | "BOUND_REACHED" | "ABORTED";
  public constructor(code: ExtendedSupportProviderAdapterError["code"]) {
    super("Extended Support provider collection did not complete");
    this.name = "ExtendedSupportProviderAdapterError";
    this.code = code;
  }
}

function reject(code: ExtendedSupportProviderAdapterError["code"]): never {
  throw new ExtendedSupportProviderAdapterError(code);
}

function sorted(values: readonly string[], pattern: RegExp, maximum: number): boolean {
  return values.length >= 1 && values.length <= maximum
    && values.every((value) => pattern.test(value))
    && JSON.stringify(values) === JSON.stringify([...new Set(values)].sort());
}

function validBoundary(value: ExtendedSupportProviderBoundary): boolean {
  return IDENTIFIER.test(value.scope.orgId) && IDENTIFIER.test(value.scope.customerId)
    && CONNECTION.test(value.scope.connectionId) && ACCOUNT.test(value.managementAccountId)
    && ["aws", "aws-cn", "aws-us-gov"].includes(value.partition)
    && sorted(value.accountIds, ACCOUNT, EXTENDED_SUPPORT_PROVIDER_BOUNDS.maximumAccounts)
    && value.accountIds.includes(value.managementAccountId)
    && sorted(value.regions, REGION, EXTENDED_SUPPORT_PROVIDER_BOUNDS.maximumRegions);
}

function exactRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resourceKey(value: unknown): string {
  if (!exactRecord(value) || typeof value.service !== "string"
    || typeof value.engine !== "string" || typeof value.supportVersionKey !== "string") return "";
  return `${value.service}:${value.engine}:${value.supportVersionKey}`;
}

function stableSort(values: readonly unknown[]): unknown[] {
  return [...values].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en-US"));
}

function assertPage(
  page: ExtendedSupportProviderPage,
  accountId: string,
  region: string,
  expectedPage: number,
): void {
  if (!exactRecord(page)
    || JSON.stringify(Object.keys(page).sort()) !== JSON.stringify([
      "accountId", "calendars", "finalPage", "observations", "pageNumber", "rates", "region",
      "schemaVersion",
    ])
    || page.schemaVersion !== "sutra.extended-support-provider-page.v1"
    || page.accountId !== accountId || page.region !== region
    || page.pageNumber !== expectedPage || typeof page.finalPage !== "boolean"
    || !Array.isArray(page.observations) || !Array.isArray(page.calendars) || !Array.isArray(page.rates)
    || page.observations.length + page.calendars.length + page.rates.length
      > EXTENDED_SUPPORT_PROVIDER_BOUNDS.maximumRecordsPerPage) {
    reject("PROVIDER_RESPONSE_INVALID");
  }
}

function assertCoverage(
  value: readonly ExtendedSupportProviderRegionCoverage[],
): void {
  const services: ExtendedSupportProviderService[] = ["EKS", "RDS", "AURORA", "OPENSEARCH", "ELASTICACHE"];
  if (value.length !== services.length
    || JSON.stringify(value.map((item) => item.service)) !== JSON.stringify(services)) {
    reject("PROVIDER_RESPONSE_INVALID");
  }
  for (const item of value) {
    if (!["SUCCEEDED", "PARTIAL", "FAILED"].includes(item.status)
      || typeof item.readPermissionsValidated !== "boolean"
      || (item.errorCode !== null && !SAFE_CODE.test(item.errorCode))
      || (item.status === "SUCCEEDED" && (!item.readPermissionsValidated || item.errorCode !== null))) {
      reject("PROVIDER_RESPONSE_INVALID");
    }
  }
}

function mergeCoverage(
  evidence: readonly (readonly ExtendedSupportProviderRegionCoverage[])[],
  boundary: ExtendedSupportProviderBoundary,
  observations: readonly unknown[],
) {
  const services: ExtendedSupportProviderService[] = ["EKS", "RDS", "AURORA", "OPENSEARCH", "ELASTICACHE"];
  return services.map((service) => {
    const rows = evidence.map((items) => items.find((item) => item.service === service)!);
    const failed = rows.filter((row) => row.status === "FAILED").length;
    const partial = rows.filter((row) => row.status === "PARTIAL").length;
    const status = failed === rows.length ? "FAILED" : failed > 0 || partial > 0 ? "PARTIAL" : "SUCCEEDED";
    const errorCodes = [...new Set(rows.map((row) => row.errorCode).filter((code): code is string => code !== null))].sort();
    return Object.freeze({
      service,
      status,
      readPermissionsValidated: rows.every((row) => row.readPermissionsValidated),
      accountIds: boundary.accountIds,
      regions: boundary.regions,
      recordCount: observations.filter((row) => exactRecord(row) && row.service === service).length,
      errorCode: errorCodes.length === 0 ? null : errorCodes.join("_").slice(0, 96),
    });
  });
}

function assertLimits(input: {
  readonly observations: readonly unknown[];
  readonly calendars: readonly unknown[];
  readonly rates: readonly unknown[];
  readonly charges: readonly unknown[];
}): void {
  if (input.observations.length > EXTENDED_SUPPORT_PROVIDER_BOUNDS.maximumObservations
    || input.calendars.length > EXTENDED_SUPPORT_PROVIDER_BOUNDS.maximumCalendarEntries
    || input.rates.length > EXTENDED_SUPPORT_PROVIDER_BOUNDS.maximumRates
    || input.charges.length > EXTENDED_SUPPORT_PROVIDER_BOUNDS.maximumObservedCharges) {
    reject("BOUND_REACHED");
  }
}

export async function collectExtendedSupportProviderEvidence(input: {
  readonly boundary: ExtendedSupportProviderBoundary;
  readonly reader: ExtendedSupportAwsReader;
  readonly signal: AbortSignal;
  readonly now?: () => number;
}): Promise<ExtendedSupportProviderCapture> {
  if (!validBoundary(input.boundary) || !(input.signal instanceof AbortSignal)
    || input.signal.aborted) reject("INVALID_REQUEST");
  const clock = input.now ?? Date.now;
  const startedAtMs = clock();
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) reject("INVALID_REQUEST");
  const timeout = AbortSignal.timeout(EXTENDED_SUPPORT_PROVIDER_BOUNDS.maximumDurationMs);
  const signal = AbortSignal.any([input.signal, timeout]);
  const observations: unknown[] = [];
  const calendars: unknown[] = [];
  const rates: unknown[] = [];
  const regionalCoverage: (readonly ExtendedSupportProviderRegionCoverage[])[] = [];
  try {
    for (const accountId of input.boundary.accountIds) {
      for (const region of input.boundary.regions) {
        if (signal.aborted) reject("ABORTED");
        const result = await input.reader.collectRegion({
          boundary: input.boundary,
          accountId,
          region,
          operations: EXTENDED_SUPPORT_PROVIDER_OPERATIONS,
          signal,
        });
        let pageNumber = 0;
        let finalSeen = false;
        for await (const page of result.pages) {
          if (signal.aborted) reject("ABORTED");
          pageNumber += 1;
          if (pageNumber > EXTENDED_SUPPORT_PROVIDER_BOUNDS.maximumPagesPerAccountRegion) reject("BOUND_REACHED");
          assertPage(page, accountId, region, pageNumber);
          if (finalSeen) reject("PROVIDER_RESPONSE_INVALID");
          finalSeen = page.finalPage;
          observations.push(...page.observations);
          calendars.push(...page.calendars);
          rates.push(...page.rates);
          assertLimits({ observations, calendars, rates, charges: [] });
        }
        if (!finalSeen) reject("PROVIDER_RESPONSE_INVALID");
        const coverage = await result.coverage;
        assertCoverage(coverage);
        regionalCoverage.push(coverage);
      }
    }
    const observedResourceKeys = [...new Set(observations.map(resourceKey).filter(Boolean))].sort();
    const supplement = await input.reader.collectSupplement({
      boundary: input.boundary,
      observedResourceKeys,
      signal,
    });
    if (supplement.schemaVersion !== "sutra.extended-support-provider-supplement.v1"
      || JSON.stringify(supplement.scope) !== JSON.stringify(input.boundary.scope)
      || !Array.isArray(supplement.calendars) || !Array.isArray(supplement.rates)
      || !Array.isArray(supplement.observedCharges)) reject("PROVIDER_RESPONSE_INVALID");
    calendars.push(...supplement.calendars);
    rates.push(...supplement.rates);
    const charges = [...supplement.observedCharges];
    assertLimits({ observations, calendars, rates, charges });
    if (signal.aborted) reject("ABORTED");
    const completedAtMs = clock();
    if (!Number.isSafeInteger(completedAtMs) || completedAtMs < startedAtMs
      || completedAtMs - startedAtMs > EXTENDED_SUPPORT_PROVIDER_BOUNDS.maximumDurationMs) reject("ABORTED");
    const core = {
      schemaVersion: "sutra.extended-support-projection.v1" as const,
      scope: input.boundary.scope,
      managementAccountId: input.boundary.managementAccountId,
      partition: input.boundary.partition,
      accountIds: input.boundary.accountIds,
      regions: input.boundary.regions,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      coverage: mergeCoverage(regionalCoverage, input.boundary, observations),
      observations: stableSort(observations),
      calendars: stableSort(calendars),
      rates: stableSort(rates),
      observedCharges: stableSort(charges),
    };
    const hash = createHash("sha256").update(JSON.stringify(core), "utf8").digest("hex");
    const capture = Object.freeze({ ...core, collectionId: `esp_${hash}` });
    if (Buffer.byteLength(JSON.stringify(capture), "utf8")
      > EXTENDED_SUPPORT_PROVIDER_BOUNDS.maximumCaptureBytes) reject("BOUND_REACHED");
    return capture;
  } catch (error) {
    if (error instanceof ExtendedSupportProviderAdapterError) throw error;
    if (signal.aborted) reject("ABORTED");
    reject("PROVIDER_RESPONSE_INVALID");
  }
}
