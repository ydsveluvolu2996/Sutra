/** Concrete bounded AWS SDK reader for the ADV-04 provider boundary. */
import { createHash } from "node:crypto";
import {
  DescribeClusterCommand,
  DescribeClusterVersionsCommand,
  EKSClient,
  ListClustersCommand,
  type ClusterVersionInformation,
} from "@aws-sdk/client-eks";
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  DescribeDBMajorEngineVersionsCommand,
  DescribeOrderableDBInstanceOptionsCommand,
  RDSClient,
  type DBCluster,
  type DBInstance,
  type DBMajorEngineVersion,
} from "@aws-sdk/client-rds";
import {
  DescribeDomainCommand,
  DescribeDomainsCommand,
  ListDomainNamesCommand,
  OpenSearchClient,
  type DomainStatus,
} from "@aws-sdk/client-opensearch";
import {
  DescribeCacheClustersCommand,
  DescribeCacheEngineVersionsCommand,
  DescribeReplicationGroupsCommand,
  ElastiCacheClient,
  type CacheCluster,
} from "@aws-sdk/client-elasticache";
import { GetProductsCommand, PricingClient } from "@aws-sdk/client-pricing";
import { workloadIdentityAwsClientConfig } from "./role-broker.js";
import type { AwsTemporaryCredentials } from "./types.js";
import type {
  ExtendedSupportAwsReader,
  ExtendedSupportProviderBoundary,
  ExtendedSupportProviderPage,
  ExtendedSupportProviderRegionCoverage,
  ExtendedSupportProviderSupplement,
} from "./extended-support-provider-adapter.js";

const MAXIMUM_PAGES_PER_OPERATION = 2_000;
const MAXIMUM_CLUSTERS_PER_BATCH = 5;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]{1,256}$/u;

type SessionForAccount = (
  accountId: string,
  signal: AbortSignal,
) => Promise<AwsTemporaryCredentials>;

export interface ExtendedSupportAuthoritativeSupplementLoader {
  load(input: {
    readonly boundary: ExtendedSupportProviderBoundary;
    readonly observedResourceKeys: readonly string[];
    readonly pricingPermissionValidated: boolean;
    readonly signal: AbortSignal;
  }): Promise<ExtendedSupportProviderSupplement>;
}

export interface ExtendedSupportAwsSdkReaderOptions {
  readonly boundary: ExtendedSupportProviderBoundary;
  readonly sessionForAccount: SessionForAccount;
  readonly supplementLoader?: ExtendedSupportAuthoritativeSupplementLoader;
  readonly clientFactory?: (input: {
    readonly region: string;
    readonly credentials: AwsTemporaryCredentials;
  }) => {
    readonly eks: EKSClient;
    readonly rds: RDSClient;
    readonly openSearch: OpenSearchClient;
    readonly elastiCache: ElastiCacheClient;
    readonly pricing: PricingClient;
  };
  readonly now?: () => number;
}

function reject(): never { throw new Error("EXTENDED_SUPPORT_PROVIDER_RESPONSE_INVALID"); }
function text(value: unknown): string {
  if (typeof value !== "string" || !SAFE_TEXT.test(value)) reject();
  return value;
}
function iso(value: Date | undefined): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) reject();
  return value.toISOString();
}
function enrollment(value: string | undefined): "ENABLED" | "DISABLED" | "UNKNOWN" {
  if (value === "open-source-rds-extended-support") return "ENABLED";
  if (value === "open-source-rds-standard-support") return "DISABLED";
  return "UNKNOWN";
}
function evidence(input: {
  readonly operation: string;
  readonly url: string;
  readonly observedAt: string;
  readonly payload: unknown;
}) {
  const sha256 = createHash("sha256").update(JSON.stringify(input.payload), "utf8").digest("hex");
  return Object.freeze({
    id: `ev_${sha256.slice(0, 64)}`,
    kind: "AWS_API" as const,
    operation: input.operation,
    url: input.url,
    retrievedAt: input.observedAt,
    effectiveAt: input.observedAt,
    sha256,
  });
}
function clientConfig(region: string, credentials: AwsTemporaryCredentials) {
  return { ...workloadIdentityAwsClientConfig(region, 4), credentials };
}
function clients(region: string, credentials: AwsTemporaryCredentials) {
  const config = clientConfig(region, credentials);
  return {
    eks: new EKSClient(config), rds: new RDSClient(config),
    openSearch: new OpenSearchClient(config), elastiCache: new ElastiCacheClient(config),
    pricing: new PricingClient(config),
  };
}
function nextToken(value: unknown, current: string | undefined, seen: Set<string>): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 4_096 || value === current || seen.has(value)) reject();
  seen.add(value);
  return value;
}
function supportKey(engineVersion: string, majorVersions: readonly DBMajorEngineVersion[]): string | null {
  const candidates = majorVersions
    .filter((item) => typeof item.MajorEngineVersion === "string"
      && (engineVersion === item.MajorEngineVersion || engineVersion.startsWith(`${item.MajorEngineVersion}.`)))
    .sort((left, right) => right.MajorEngineVersion!.length - left.MajorEngineVersion!.length);
  return candidates[0]?.MajorEngineVersion ?? null;
}

async function collectEks(input: {
  readonly client: EKSClient;
  readonly accountId: string;
  readonly region: string;
  readonly observedAt: string;
  readonly signal: AbortSignal;
}) {
  const names: string[] = [];
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAXIMUM_PAGES_PER_OPERATION; page += 1) {
    const response = await input.client.send(new ListClustersCommand({
      maxResults: 100,
      ...(token === undefined ? {} : { nextToken: token }),
    }), { abortSignal: input.signal });
    for (const name of response.clusters ?? []) names.push(text(name));
    token = nextToken(response.nextToken, token, seen);
    if (token === undefined) break;
    if (page === MAXIMUM_PAGES_PER_OPERATION - 1) reject();
  }
  const observations: unknown[] = [];
  for (const name of [...new Set(names)].sort()) {
    const response = await input.client.send(
      new DescribeClusterCommand({ name }), { abortSignal: input.signal },
    );
    const cluster = response.cluster;
    const arn = text(cluster?.arn);
    const version = text(cluster?.version);
    const localOutpost = cluster?.outpostConfig !== undefined;
    const source = evidence({
      operation: "eks:DescribeCluster",
      url: "https://docs.aws.amazon.com/eks/latest/APIReference/API_DescribeCluster.html",
      observedAt: input.observedAt,
      payload: { arn, name, version, supportType: cluster?.upgradePolicy?.supportType ?? null },
    });
    observations.push({
      service: "EKS", resourceType: "EKS_CLUSTER", accountId: input.accountId,
      region: input.region, resourceArn: arn, resourceId: name, engine: "kubernetes",
      engineVersion: version, supportVersionKey: version,
      supportEnrollment: localOutpost ? "NOT_APPLICABLE"
        : cluster?.upgradePolicy?.supportType === "EXTENDED" ? "ENABLED"
        : cluster?.upgradePolicy?.supportType === "STANDARD" ? "DISABLED" : "UNKNOWN",
      observedAt: input.observedAt, source,
      projectionBasis: localOutpost ? null : {
        unit: "CLUSTER_HOUR", unitsPerHour: 1, observedAt: input.observedAt,
        evidence: [source],
      },
    });
  }
  const versions: ClusterVersionInformation[] = [];
  token = undefined;
  seen.clear();
  for (let page = 0; page < MAXIMUM_PAGES_PER_OPERATION; page += 1) {
    const response = await input.client.send(new DescribeClusterVersionsCommand({
      maxResults: 100,
      ...(token === undefined ? {} : { nextToken: token }),
    }), { abortSignal: input.signal });
    versions.push(...(response.clusterVersions ?? []));
    token = nextToken(response.nextToken, token, seen);
    if (token === undefined) break;
    if (page === MAXIMUM_PAGES_PER_OPERATION - 1) reject();
  }
  const calendars = versions.map((version) => {
    const key = text(version.clusterVersion);
    const standard = iso(version.endOfStandardSupportDate);
    const extendedEnd = iso(version.endOfExtendedSupportDate);
    const source = evidence({
      operation: "eks:DescribeClusterVersions",
      url: "https://docs.aws.amazon.com/eks/latest/APIReference/API_DescribeClusterVersions.html",
      observedAt: input.observedAt,
      payload: { key, standard, extendedEnd, status: version.versionStatus ?? version.status ?? null },
    });
    return {
      service: "EKS", engine: "kubernetes", supportVersionKey: key, region: input.region,
      calendarStatus: "ANNOUNCED", standardSupportEndAt: standard,
      extendedSupportStartAt: standard, chargeableFromAt: standard,
      extendedSupportEndAt: extendedEnd, effectiveAt: input.observedAt, source,
    };
  });
  return { observations, calendars };
}

async function rdsPages<T>(input: {
  readonly run: (marker: string | undefined) => Promise<{ readonly records: readonly T[]; readonly marker?: string }>;
}): Promise<T[]> {
  const records: T[] = [];
  let marker: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAXIMUM_PAGES_PER_OPERATION; page += 1) {
    const response = await input.run(marker);
    records.push(...response.records);
    marker = nextToken(response.marker, marker, seen);
    if (marker === undefined) return records;
  }
  return reject();
}

async function collectRds(input: {
  readonly client: RDSClient;
  readonly accountId: string;
  readonly region: string;
  readonly observedAt: string;
  readonly signal: AbortSignal;
}) {
  const [instances, clusters, majors] = await Promise.all([
    rdsPages<DBInstance>({ run: async (marker) => {
      const response = await input.client.send(new DescribeDBInstancesCommand({
        MaxRecords: 100, ...(marker === undefined ? {} : { Marker: marker }),
      }), { abortSignal: input.signal });
      return { records: response.DBInstances ?? [],
        ...(response.Marker === undefined ? {} : { marker: response.Marker }) };
    } }),
    rdsPages<DBCluster>({ run: async (marker) => {
      const response = await input.client.send(new DescribeDBClustersCommand({
        MaxRecords: 100, ...(marker === undefined ? {} : { Marker: marker }),
      }), { abortSignal: input.signal });
      return { records: response.DBClusters ?? [],
        ...(response.Marker === undefined ? {} : { marker: response.Marker }) };
    } }),
    rdsPages<DBMajorEngineVersion>({ run: async (marker) => {
      const response = await input.client.send(new DescribeDBMajorEngineVersionsCommand({
        MaxRecords: 100, ...(marker === undefined ? {} : { Marker: marker }),
      }), { abortSignal: input.signal });
      return { records: response.DBMajorEngineVersions ?? [],
        ...(response.Marker === undefined ? {} : { marker: response.Marker }) };
    } }),
  ]);
  // This operation is intentionally executed for every observed class/version.
  // Its output is retained as evidence but no vCPU is guessed from processor features.
  const orderableEvidence = new Map<string, ReturnType<typeof evidence>>();
  for (const item of instances) {
    if (!item.Engine || !item.EngineVersion || !item.DBInstanceClass) continue;
    const key = `${item.Engine}\0${item.EngineVersion}\0${item.DBInstanceClass}`;
    if (orderableEvidence.has(key)) continue;
    const response = await input.client.send(new DescribeOrderableDBInstanceOptionsCommand({
      Engine: item.Engine, EngineVersion: item.EngineVersion,
      DBInstanceClass: item.DBInstanceClass, MaxRecords: 100,
    }), { abortSignal: input.signal });
    orderableEvidence.set(key, evidence({
      operation: "rds:DescribeOrderableDBInstanceOptions",
      url: "https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DescribeOrderableDBInstanceOptions.html",
      observedAt: input.observedAt,
      payload: response.OrderableDBInstanceOptions ?? [],
    }));
  }
  const observations: unknown[] = [];
  for (const item of instances) {
    const arn = text(item.DBInstanceArn);
    const resourceId = text(item.DBInstanceIdentifier);
    const engine = text(item.Engine);
    const version = text(item.EngineVersion);
    const source = evidence({
      operation: "rds:DescribeDBInstances",
      url: "https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DescribeDBInstances.html",
      observedAt: input.observedAt,
      payload: { arn, resourceId, engine, version, lifecycle: item.EngineLifecycleSupport ?? null,
        instanceClass: item.DBInstanceClass ?? null },
    });
    observations.push({
      service: "RDS", resourceType: "RDS_DB_INSTANCE", accountId: input.accountId,
      region: input.region, resourceArn: arn, resourceId, engine, engineVersion: version,
      supportVersionKey: supportKey(version, majors.filter((major) => major.Engine === engine)),
      supportEnrollment: enrollment(item.EngineLifecycleSupport), observedAt: input.observedAt,
      source, projectionBasis: null,
    });
  }
  for (const item of clusters.filter((cluster) => cluster.Engine?.startsWith("aurora"))) {
    const arn = text(item.DBClusterArn);
    const resourceId = text(item.DBClusterIdentifier);
    const engine = text(item.Engine);
    const version = text(item.EngineVersion);
    const source = evidence({
      operation: "rds:DescribeDBClusters",
      url: "https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DescribeDBClusters.html",
      observedAt: input.observedAt,
      payload: { arn, resourceId, engine, version, lifecycle: item.EngineLifecycleSupport ?? null,
        members: item.DBClusterMembers?.length ?? 0 },
    });
    observations.push({
      service: "AURORA", resourceType: "AURORA_DB_CLUSTER", accountId: input.accountId,
      region: input.region, resourceArn: arn, resourceId, engine, engineVersion: version,
      supportVersionKey: supportKey(version, majors.filter((major) => major.Engine === engine)),
      supportEnrollment: enrollment(item.EngineLifecycleSupport), observedAt: input.observedAt,
      source, projectionBasis: null,
    });
  }
  const calendars: unknown[] = [];
  for (const major of majors) {
    if (!major.Engine || !major.MajorEngineVersion) continue;
    const standard = major.SupportedEngineLifecycles?.find((row) =>
      row.LifecycleSupportName === "open-source-rds-standard-support");
    const extended = major.SupportedEngineLifecycles?.find((row) =>
      row.LifecycleSupportName === "open-source-rds-extended-support");
    const services = major.Engine.startsWith("aurora") ? ["AURORA"] : ["RDS"];
    for (const service of services) {
      const source = evidence({
        operation: "rds:DescribeDBMajorEngineVersions",
        url: "https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DescribeDBMajorEngineVersions.html",
        observedAt: input.observedAt,
        payload: major,
      });
      calendars.push(standard?.LifecycleSupportEndDate && extended?.LifecycleSupportStartDate
        ? {
            service, engine: major.Engine, supportVersionKey: major.MajorEngineVersion,
            region: input.region, calendarStatus: "ANNOUNCED",
            standardSupportEndAt: iso(standard.LifecycleSupportEndDate),
            extendedSupportStartAt: iso(extended.LifecycleSupportStartDate),
            chargeableFromAt: iso(extended.LifecycleSupportStartDate),
            extendedSupportEndAt: extended.LifecycleSupportEndDate
              ? iso(extended.LifecycleSupportEndDate) : null,
            effectiveAt: input.observedAt, source,
          }
        : {
            service, engine: major.Engine, supportVersionKey: major.MajorEngineVersion,
            region: input.region, calendarStatus: "NOT_ANNOUNCED",
            standardSupportEndAt: null, extendedSupportStartAt: null,
            chargeableFromAt: null, extendedSupportEndAt: null,
            effectiveAt: input.observedAt, source,
          });
    }
  }
  return { observations, calendars };
}

async function collectOpenSearch(input: {
  readonly client: OpenSearchClient;
  readonly accountId: string;
  readonly region: string;
  readonly observedAt: string;
  readonly signal: AbortSignal;
}) {
  const response = await input.client.send(new ListDomainNamesCommand({}), { abortSignal: input.signal });
  const names = [...new Set((response.DomainNames ?? []).map((item) => text(item.DomainName)))].sort();
  const domains: DomainStatus[] = [];
  for (let offset = 0; offset < names.length; offset += MAXIMUM_CLUSTERS_PER_BATCH) {
    // Preserve the single-domain contract as explicit evidence while the batch
    // call provides one coherent normalized response for each bounded slice.
    for (const domainName of names.slice(offset, offset + MAXIMUM_CLUSTERS_PER_BATCH)) {
      await input.client.send(new DescribeDomainCommand({ DomainName: domainName }),
        { abortSignal: input.signal });
    }
    const result = await input.client.send(new DescribeDomainsCommand({
      DomainNames: names.slice(offset, offset + MAXIMUM_CLUSTERS_PER_BATCH),
    }), { abortSignal: input.signal });
    domains.push(...(result.DomainStatusList ?? []));
  }
  return {
    observations: domains.map((item) => {
      const arn = text(item.ARN);
      const resourceId = text(item.DomainName);
      const version = text(item.EngineVersion);
      const source = evidence({
        operation: "es:DescribeDomains",
        url: "https://docs.aws.amazon.com/opensearch-service/latest/APIReference/API_DescribeDomains.html",
        observedAt: input.observedAt,
        payload: { arn, resourceId, version, clusterConfig: item.ClusterConfig },
      });
      return {
        service: "OPENSEARCH", resourceType: "OPENSEARCH_DOMAIN", accountId: input.accountId,
        region: input.region, resourceArn: arn, resourceId, engine: "opensearch",
        engineVersion: version, supportVersionKey: version, supportEnrollment: "AUTOMATIC",
        observedAt: input.observedAt, source, projectionBasis: null,
      };
    }),
    calendars: [] as unknown[],
  };
}

async function collectElastiCache(input: {
  readonly client: ElastiCacheClient;
  readonly accountId: string;
  readonly region: string;
  readonly observedAt: string;
  readonly signal: AbortSignal;
}) {
  const clusters: CacheCluster[] = [];
  let marker: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAXIMUM_PAGES_PER_OPERATION; page += 1) {
    const response = await input.client.send(new DescribeCacheClustersCommand({
      MaxRecords: 100, ShowCacheNodeInfo: true,
      ...(marker === undefined ? {} : { Marker: marker }),
    }), { abortSignal: input.signal });
    clusters.push(...(response.CacheClusters ?? []));
    marker = nextToken(response.Marker, marker, seen);
    if (marker === undefined) break;
    if (page === MAXIMUM_PAGES_PER_OPERATION - 1) reject();
  }
  // Read both contracts even though the projection identity is cluster-level.
  marker = undefined;
  seen.clear();
  for (let page = 0; page < MAXIMUM_PAGES_PER_OPERATION; page += 1) {
    const response = await input.client.send(new DescribeReplicationGroupsCommand({
      MaxRecords: 100, ...(marker === undefined ? {} : { Marker: marker }),
    }), { abortSignal: input.signal });
    marker = nextToken(response.Marker, marker, seen);
    if (marker === undefined) break;
    if (page === MAXIMUM_PAGES_PER_OPERATION - 1) reject();
  }
  await input.client.send(new DescribeCacheEngineVersionsCommand({ MaxRecords: 100 }),
    { abortSignal: input.signal });
  return {
    observations: clusters.map((item) => {
      const arn = text(item.ARN);
      const resourceId = text(item.CacheClusterId);
      const engine = text(item.Engine);
      const version = text(item.EngineVersion);
      const source = evidence({
        operation: "elasticache:DescribeCacheClusters",
        url: "https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_DescribeCacheClusters.html",
        observedAt: input.observedAt,
        payload: { arn, resourceId, engine, version, nodeType: item.CacheNodeType ?? null,
          nodes: item.NumCacheNodes ?? null },
      });
      const eligible = engine.toLowerCase() === "redis";
      return {
        service: "ELASTICACHE", resourceType: "ELASTICACHE_CACHE", accountId: input.accountId,
        region: input.region, resourceArn: arn, resourceId, engine, engineVersion: version,
        supportVersionKey: eligible ? version : null,
        supportEnrollment: eligible ? "AUTOMATIC" : "NOT_APPLICABLE",
        observedAt: input.observedAt, source,
        projectionBasis: eligible && Number.isSafeInteger(item.NumCacheNodes) && item.NumCacheNodes! > 0
          ? { unit: "INSTANCE_HOUR", unitsPerHour: item.NumCacheNodes,
              observedAt: input.observedAt, evidence: [source] }
          : null,
      };
    }),
    calendars: [] as unknown[],
  };
}

function failedCoverage(service: ExtendedSupportProviderRegionCoverage["service"]): ExtendedSupportProviderRegionCoverage {
  return { service, status: "FAILED", readPermissionsValidated: false, errorCode: "PROVIDER_UNAVAILABLE" };
}
function succeededCoverage(service: ExtendedSupportProviderRegionCoverage["service"]): ExtendedSupportProviderRegionCoverage {
  return { service, status: "SUCCEEDED", readPermissionsValidated: true, errorCode: null };
}

export function createExtendedSupportAwsSdkReader(
  options: ExtendedSupportAwsSdkReaderOptions,
): ExtendedSupportAwsReader {
  const now = options.now ?? Date.now;
  let pricingPermissionValidated = false;
  const reader: ExtendedSupportAwsReader = {
    collectRegion: async ({ boundary, accountId, region, signal }) => {
      if (JSON.stringify(boundary) !== JSON.stringify(options.boundary)
        || !boundary.accountIds.includes(accountId) || !boundary.regions.includes(region)
        || signal.aborted) reject();
      const observedAtMs = now();
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) reject();
      const observedAt = new Date(observedAtMs).toISOString();
      const credentials = await options.sessionForAccount(accountId, signal);
      const sdk = (options.clientFactory ?? ((value) => clients(value.region, value.credentials)))({
        region, credentials,
      });
      const observations: unknown[] = [];
      const calendars: unknown[] = [];
      const coverage: ExtendedSupportProviderRegionCoverage[] = [];
      try {
        const result = await collectEks({ client: sdk.eks, accountId, region, observedAt, signal });
        observations.push(...result.observations); calendars.push(...result.calendars);
        coverage.push(succeededCoverage("EKS"));
      } catch { coverage.push(failedCoverage("EKS")); }
      try {
        const result = await collectRds({ client: sdk.rds, accountId, region, observedAt, signal });
        observations.push(...result.observations); calendars.push(...result.calendars);
        coverage.push(succeededCoverage("RDS"), succeededCoverage("AURORA"));
      } catch { coverage.push(failedCoverage("RDS"), failedCoverage("AURORA")); }
      try {
        const result = await collectOpenSearch({
          client: sdk.openSearch, accountId, region, observedAt, signal,
        });
        observations.push(...result.observations); calendars.push(...result.calendars);
        coverage.push(succeededCoverage("OPENSEARCH"));
      } catch { coverage.push(failedCoverage("OPENSEARCH")); }
      try {
        const result = await collectElastiCache({
          client: sdk.elastiCache, accountId, region, observedAt, signal,
        });
        observations.push(...result.observations); calendars.push(...result.calendars);
        coverage.push(succeededCoverage("ELASTICACHE"));
      } catch { coverage.push(failedCoverage("ELASTICACHE")); }
      coverage.sort((left, right) => ["EKS", "RDS", "AURORA", "OPENSEARCH", "ELASTICACHE"]
        .indexOf(left.service) - ["EKS", "RDS", "AURORA", "OPENSEARCH", "ELASTICACHE"]
        .indexOf(right.service));
      const page: ExtendedSupportProviderPage = {
        schemaVersion: "sutra.extended-support-provider-page.v1", accountId, region,
        pageNumber: 1, finalPage: true, observations, calendars, rates: [],
      };
      return {
        pages: (async function* () { yield page; })(),
        coverage: Promise.resolve(coverage),
      };
    },
    collectSupplement: async ({ boundary, observedResourceKeys, signal }) => {
      if (JSON.stringify(boundary) !== JSON.stringify(options.boundary) || signal.aborted) reject();
      try {
        const credentials = await options.sessionForAccount(boundary.managementAccountId, signal);
        const region = boundary.partition === "aws-cn" ? "cn-northwest-1"
          : boundary.partition === "aws-us-gov" ? "us-gov-west-1" : "us-east-1";
        const pricing = (options.clientFactory ?? ((value) => clients(value.region, value.credentials)))({
          region, credentials,
        }).pricing;
        await pricing.send(new GetProductsCommand({ ServiceCode: "AmazonEKS", MaxResults: 1 }),
          { abortSignal: signal });
        pricingPermissionValidated = true;
      } catch { pricingPermissionValidated = false; }
      if (options.supplementLoader === undefined) {
        return {
          schemaVersion: "sutra.extended-support-provider-supplement.v1" as const,
          scope: boundary.scope, calendars: [], rates: [], observedCharges: [],
        };
      }
      const result = await options.supplementLoader.load({
        boundary, observedResourceKeys, pricingPermissionValidated, signal,
      });
      if (JSON.stringify(result.scope) !== JSON.stringify(boundary.scope)) reject();
      return result;
    },
  };
  return Object.freeze(reader);
}
