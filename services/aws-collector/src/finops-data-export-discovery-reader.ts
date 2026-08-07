/**
 * Concrete AWS SDK v3 reader for Foundational billing export discovery.
 *
 * Enumerates the customer's AWS Data Exports and resolves the S3 destination of
 * the CUR 2.0 or FOCUS 1.2 export that feeds FND-01/02/03. Only two actions are
 * used, `bcm-data-exports:ListExports` and `bcm-data-exports:GetExport`, both of
 * which the deployed permission pack `standard-2026-08.12` already grants; this
 * reader must never reach for a third.
 *
 * It reads configuration, never billing rows. The manifest and object reads that
 * follow are performed by the existing S3 path under the same session.
 */
import {
  BCMDataExportsClient,
  GetExportCommand,
  ListExportsCommand,
} from "@aws-sdk/client-bcm-data-exports";

import { workloadIdentityAwsClientConfig } from "./role-broker.js";
import type { AwsTemporaryCredentials } from "./types.js";

/**
 * The two Foundational export contracts, keyed by the exact `TableConfigurations`
 * table name AWS reports. Anything else is not a Foundational source and is
 * ignored rather than guessed at.
 */
export const FOUNDATIONAL_EXPORT_TABLES = Object.freeze({
  COST_AND_USAGE_REPORT: "foundational-cur2-export-v1",
  FOCUS_1_2_AWS: "foundational-focus12-export-v1",
} as const);

export type FoundationalExportTable = keyof typeof FOUNDATIONAL_EXPORT_TABLES;
export type FoundationalExportContractId =
  (typeof FOUNDATIONAL_EXPORT_TABLES)[FoundationalExportTable];

export interface DiscoveredDataExport {
  readonly exportArn: string;
  readonly exportName: string;
  readonly table: FoundationalExportTable;
  readonly contractId: FoundationalExportContractId;
  readonly bucket: string;
  /** Destination root including the export name and a trailing slash. */
  readonly prefix: string;
  readonly region: string;
}

/**
 * `unavailable` is not `none`.
 *
 * A customer with no CUR 2.0 export and a customer whose role was denied
 * `ListExports` are different facts, and a dashboard that renders them the same
 * way tells an operator to go looking in the wrong place. The caller must be
 * able to tell them apart, so the outcome is a discriminated union rather than
 * an array that happens to be empty.
 */
export type DataExportDiscoveryOutcome =
  | { readonly kind: "discovered"; readonly exports: readonly DiscoveredDataExport[] }
  | { readonly kind: "none" }
  | { readonly kind: "unavailable"; readonly reason: "ACCESS_DENIED" | "THROTTLED" | "PROVIDER_ERROR" };

export class DataExportDiscoveryError extends Error {
  public constructor(public readonly code: "PROVIDER_RESPONSE_INVALID" | "ABORTED") {
    super("AWS Data Export discovery failed");
    this.name = "DataExportDiscoveryError";
  }
}

const EXPORT_NAME = /^[A-Za-z0-9_-]{1,128}$/u;
const BUCKET =
  /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/u;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/u;
const EXPORT_ARN =
  /^arn:aws(?:-[a-z]+)*:bcm-data-exports:[a-z0-9-]*:\d{12}:export\/[A-Za-z0-9_-]{1,128}$/u;

// AWS returns at most 100 exports per page. A tenant with more than a few
// hundred is not expected; the cap exists so a pathological account cannot make
// discovery unbounded, and a truncated sweep is reported rather than silently
// treated as the whole set.
const MAX_PAGES = 10;

interface AwsSdkClient {
  send(command: unknown, options: { readonly abortSignal: AbortSignal }): Promise<unknown>;
  destroy?(): void;
}

export interface DataExportDiscoveryReaderOptions {
  readonly region: string;
  readonly credentials: AwsTemporaryCredentials;
  readonly clientFactory?: (input: {
    readonly region: string;
    readonly credentials: AwsTemporaryCredentials;
  }) => AwsSdkClient;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Maps an SDK failure onto the outcome vocabulary.
 *
 * An authorization failure and a throttle are both "we do not know", but they
 * need different operator responses, so they stay distinct. Anything else is a
 * provider error rather than an assumption that there are no exports.
 */
function unavailableFor(error: unknown): DataExportDiscoveryOutcome | null {
  const name = record(error) && typeof error.name === "string" ? error.name : "";
  if (name === "AbortError") return null;
  if (name === "AccessDeniedException" || name === "UnauthorizedException") {
    return { kind: "unavailable", reason: "ACCESS_DENIED" };
  }
  if (name === "ThrottlingException" || name === "TooManyRequestsException") {
    return { kind: "unavailable", reason: "THROTTLED" };
  }
  return { kind: "unavailable", reason: "PROVIDER_ERROR" };
}

/**
 * Resolves the destination of one export.
 *
 * `ListExports` returns only identity; the S3 destination lives on the detail,
 * so every candidate costs one `GetExport`. Candidates are filtered by table
 * name first so a tenant with many unrelated exports does not pay for all of
 * them.
 */
function destinationOf(detail: unknown): Omit<DiscoveredDataExport, "region"> | null {
  if (!record(detail)) return null;
  const exportDetail = record(detail.Export) ? detail.Export : null;
  if (exportDetail === null) return null;

  const name = exportDetail.Name;
  const arn = exportDetail.ExportArn;
  if (typeof name !== "string" || !EXPORT_NAME.test(name)) return null;
  if (typeof arn !== "string" || !EXPORT_ARN.test(arn)) return null;

  const tables = exportDetail.DataQuery;
  const tableName = record(tables) && typeof tables.TableConfigurations === "object"
    && tables.TableConfigurations !== null
    ? Object.keys(tables.TableConfigurations)[0]
    : undefined;
  if (tableName === undefined || !(tableName in FOUNDATIONAL_EXPORT_TABLES)) return null;
  const table = tableName as FoundationalExportTable;

  const destinations = record(exportDetail.DestinationConfigurations)
    ? exportDetail.DestinationConfigurations
    : null;
  const s3 = destinations !== null && record(destinations.S3Destination)
    ? destinations.S3Destination
    : null;
  if (s3 === null) return null;

  const bucket = s3.S3Bucket;
  const rawPrefix = s3.S3Prefix;
  if (typeof bucket !== "string" || !BUCKET.test(bucket)) return null;
  if (typeof rawPrefix !== "string" || rawPrefix.length === 0 || rawPrefix.length > 512) return null;
  if (rawPrefix.startsWith("/") || rawPrefix.includes("..")) return null;

  // The ingest contract expects the export-name root with a trailing slash. AWS
  // reports the configured prefix without the export segment, so it is appended
  // here rather than assumed to be present.
  const base = rawPrefix.endsWith("/") ? rawPrefix : `${rawPrefix}/`;
  const prefix = base.endsWith(`${name}/`) ? base : `${base}${name}/`;

  return {
    exportArn: arn,
    exportName: name,
    table,
    contractId: FOUNDATIONAL_EXPORT_TABLES[table],
    bucket,
    prefix,
  };
}

/**
 * Enumerates Foundational billing exports for one customer session.
 *
 * The client is built per call and destroyed before returning: no tenant
 * identity, credential or pagination token survives a single discovery.
 */
export async function discoverFoundationalDataExports(
  options: DataExportDiscoveryReaderOptions,
  signal: AbortSignal,
): Promise<DataExportDiscoveryOutcome> {
  if (!REGION.test(options.region)) {
    throw new DataExportDiscoveryError("PROVIDER_RESPONSE_INVALID");
  }
  const client = (options.clientFactory ?? ((input) =>
    new BCMDataExportsClient({
      ...workloadIdentityAwsClientConfig(input.region, 4),
      credentials: input.credentials,
    }) as unknown as AwsSdkClient))({
      region: options.region,
      credentials: options.credentials,
    });

  try {
    const candidates: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      if (signal.aborted) throw new DataExportDiscoveryError("ABORTED");
      let page: unknown;
      try {
        page = await client.send(
          new ListExportsCommand(token === undefined ? {} : { NextToken: token }),
          { abortSignal: signal },
        );
      } catch (error) {
        const outcome = unavailableFor(error);
        if (outcome === null) throw new DataExportDiscoveryError("ABORTED");
        return outcome;
      }
      if (!record(page)) throw new DataExportDiscoveryError("PROVIDER_RESPONSE_INVALID");
      const references = Array.isArray(page.Exports) ? page.Exports : [];
      for (const reference of references) {
        if (!record(reference)) continue;
        const arn = reference.ExportArn;
        if (typeof arn === "string" && EXPORT_ARN.test(arn)) candidates.push(arn);
      }
      token = typeof page.NextToken === "string" && page.NextToken.length > 0
        ? page.NextToken
        : undefined;
      pages += 1;
    } while (token !== undefined && pages < MAX_PAGES);

    if (candidates.length === 0) return { kind: "none" };

    const discovered: DiscoveredDataExport[] = [];
    for (const arn of candidates) {
      if (signal.aborted) throw new DataExportDiscoveryError("ABORTED");
      let detail: unknown;
      try {
        detail = await client.send(
          new GetExportCommand({ ExportArn: arn }),
          { abortSignal: signal },
        );
      } catch (error) {
        const outcome = unavailableFor(error);
        if (outcome === null) throw new DataExportDiscoveryError("ABORTED");
        // One unreadable export must not erase the ones already resolved, but
        // it also must not be reported as "no such export". Surface the
        // unavailability only when nothing at all could be resolved.
        if (discovered.length === 0) return outcome;
        continue;
      }
      const resolved = destinationOf(detail);
      if (resolved !== null) discovered.push({ ...resolved, region: options.region });
    }

    if (discovered.length === 0) return { kind: "none" };
    // Deterministic order: two runs over the same account must produce the same
    // observation payload, or the outbox's payload-hash idempotency is defeated.
    return {
      kind: "discovered",
      exports: [...discovered].sort((left, right) =>
        left.exportArn.localeCompare(right.exportArn)),
    };
  } finally {
    client.destroy?.();
  }
}
