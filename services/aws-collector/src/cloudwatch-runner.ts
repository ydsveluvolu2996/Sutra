import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
  type GetMetricDataCommandInput,
  type GetMetricDataCommandOutput,
  type ListMetricsCommandInput,
  type ListMetricsCommandOutput,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";

import type { AwsTemporaryCredentials } from "./types.js";
import { workloadIdentityAwsClientConfig } from "./role-broker.js";

/**
 * Read-only CloudWatch utilization runner. For collected EC2 instances it reads
 * CPUUtilization + NetworkIn/NetworkOut (AWS/EC2) and, only when the CloudWatch
 * agent publishes it, mem_used_percent (CWAgent) — leaving memory UNKNOWN
 * (null) otherwise so a memory-bound workload is never silently downsized
 * downstream. It calls exactly cloudwatch:GetMetricData and cloudwatch:ListMetrics.
 *
 * Fixture mode returns representative, deterministic samples (no AWS calls);
 * live mode issues the bounded read-only calls above. Nothing here mutates AWS.
 */

const NAMESPACE_EC2 = "AWS/EC2";
const NAMESPACE_CWAGENT = "CWAgent";
const CPU_METRIC = "CPUUtilization";
const NETWORK_IN_METRIC = "NetworkIn";
const NETWORK_OUT_METRIC = "NetworkOut";
const MEMORY_METRIC = "mem_used_percent";
const P95_STAT = "p95";

const MIN_WINDOW_DAYS = 14;
const MAX_WINDOW_DAYS = 30;
const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_PERIOD_SECONDS = 3_600; // coarse, keeps datapoint volume bounded
const MAX_INSTANCES = 500;
const INSTANCE_CHUNK = 100; // <= 500 GetMetricData queries per call (<= 4 queries/instance)
const MAX_METRIC_DATA_PAGES = 50;
const MAX_LIST_METRICS_PAGES = 20;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+$/u;

export interface Ec2UtilizationSample {
  readonly resourceKey: string;
  readonly instanceId: string;
  readonly region: string;
  readonly instanceType: string | null;
  readonly cpuP95Percent: number | null;
  readonly networkP95BytesPerMinute: number | null;
  /** Null when the CloudWatch agent does not publish mem_used_percent for the instance. */
  readonly memoryP95Percent: number | null;
  readonly sampleWindowDays: number;
  readonly datapointCount: number;
}

export type Ec2UtilizationStatus = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";

export interface Ec2UtilizationCollection {
  readonly schemaVersion: "sutra.aws-utilization.v1";
  readonly status: Ec2UtilizationStatus;
  readonly accountId: string;
  readonly collectedAt: string;
  readonly windowStartIso: string;
  readonly windowEndIso: string;
  readonly windowDays: number;
  readonly periodSeconds: number;
  readonly samples: readonly Ec2UtilizationSample[];
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

export const UTILIZATION_DISCLAIMER =
  "Utilization samples are read-only CloudWatch metrics (CPUUtilization, NetworkIn/Out, " +
  "and mem_used_percent only when the CloudWatch agent publishes it) aggregated as the " +
  "peak p95 over the observation window. Memory is left unknown when the agent metric is " +
  "absent. No AWS resource is modified and no saving is claimed here.";

export interface CollectedEc2Instance {
  readonly instanceId: string;
  readonly region: string;
  readonly instanceType?: string | null;
  readonly resourceKey?: string;
}

export interface CloudWatchUtilizationReader {
  getMetricData(input: GetMetricDataCommandInput): Promise<GetMetricDataCommandOutput>;
  listMetrics(input: ListMetricsCommandInput): Promise<ListMetricsCommandOutput>;
}

export type CloudWatchReaderFactory = (
  region: string,
  credentials: AwsTemporaryCredentials,
) => CloudWatchUtilizationReader;

export interface Ec2UtilizationCollectionOptions {
  readonly accountId: string;
  readonly instances: readonly CollectedEc2Instance[];
  readonly credentials: AwsTemporaryCredentials;
  readonly windowDays?: number;
  readonly periodSeconds?: number;
  readonly now?: () => Date;
  /** Injectable for tests; a real per-region CloudWatch reader is built otherwise. */
  readonly readerFactory?: CloudWatchReaderFactory;
}

function clampWindowDays(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_WINDOW_DAYS;
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.trunc(value)));
}

function clampPeriodSeconds(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PERIOD_SECONDS;
  // CloudWatch periods must be multiples of 60; keep them coarse.
  const rounded = Math.max(300, Math.min(86_400, Math.round(value / 60) * 60));
  return rounded;
}

function safeP95(values: readonly (number | undefined)[] | undefined): { peak: number | null; count: number } {
  if (values === undefined) return { peak: null, count: 0 };
  let peak: number | null = null;
  let count = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    count += 1;
    if (peak === null || value > peak) peak = value;
  }
  return { peak, count };
}

function createCloudWatchReader(
  region: string,
  credentials: AwsTemporaryCredentials,
): CloudWatchUtilizationReader {
  const client = new CloudWatchClient({
    ...workloadIdentityAwsClientConfig(region, 3),
    credentials,
  });
  return {
    getMetricData: (input) => client.send(new GetMetricDataCommand(input)),
    listMetrics: (input) => client.send(new ListMetricsCommand(input)),
  };
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/** Metrics the CloudWatch agent publishes mem_used_percent for, keyed by instance id. */
async function memoryInstrumentedInstances(
  reader: CloudWatchUtilizationReader,
  instanceIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const instrumented = new Set<string>();
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_LIST_METRICS_PAGES; page += 1) {
    const output = await reader.listMetrics({
      Namespace: NAMESPACE_CWAGENT,
      MetricName: MEMORY_METRIC,
      ...(nextToken === undefined ? {} : { NextToken: nextToken }),
    });
    for (const metric of output.Metrics ?? []) {
      for (const dimension of metric.Dimensions ?? []) {
        if (dimension.Name === "InstanceId" && dimension.Value !== undefined && instanceIds.has(dimension.Value)) {
          instrumented.add(dimension.Value);
        }
      }
    }
    nextToken = output.NextToken;
    if (nextToken === undefined || nextToken.length === 0) break;
  }
  return instrumented;
}

function ec2Query(id: string, metricName: string, instanceId: string, period: number): MetricDataQuery {
  return {
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: NAMESPACE_EC2,
        MetricName: metricName,
        Dimensions: [{ Name: "InstanceId", Value: instanceId }],
      },
      Period: period,
      Stat: P95_STAT,
    },
    ReturnData: true,
  };
}

function memoryQuery(id: string, instanceId: string, period: number): MetricDataQuery {
  return {
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: NAMESPACE_CWAGENT,
        MetricName: MEMORY_METRIC,
        Dimensions: [{ Name: "InstanceId", Value: instanceId }],
      },
      Period: period,
      Stat: P95_STAT,
    },
    ReturnData: true,
  };
}

async function readMetricData(
  reader: CloudWatchUtilizationReader,
  queries: readonly MetricDataQuery[],
  windowStart: Date,
  windowEnd: Date,
): Promise<Map<string, (number | undefined)[]>> {
  const values = new Map<string, (number | undefined)[]>();
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_METRIC_DATA_PAGES; page += 1) {
    const output = await reader.getMetricData({
      StartTime: windowStart,
      EndTime: windowEnd,
      ScanBy: "TimestampDescending",
      MetricDataQueries: [...queries],
      ...(nextToken === undefined ? {} : { NextToken: nextToken }),
    });
    for (const result of output.MetricDataResults ?? []) {
      if (result.Id === undefined) continue;
      const existing = values.get(result.Id) ?? [];
      existing.push(...(result.Values ?? []));
      values.set(result.Id, existing);
    }
    nextToken = output.NextToken;
    if (nextToken === undefined || nextToken.length === 0) break;
  }
  return values;
}

/** Deterministic, representative fixture samples — no AWS calls. */
export function fixtureEc2Utilization(
  options: Pick<Ec2UtilizationCollectionOptions, "accountId" | "instances" | "windowDays" | "periodSeconds" | "now">,
): Ec2UtilizationCollection {
  const now = options.now?.() ?? new Date();
  const windowDays = clampWindowDays(options.windowDays);
  const periodSeconds = clampPeriodSeconds(options.periodSeconds);
  const windowEnd = now;
  const windowStart = new Date(windowEnd.getTime() - windowDays * 86_400_000);
  const samples: Ec2UtilizationSample[] = options.instances.slice(0, MAX_INSTANCES).map((instance) => {
    const profile = fixtureProfile(instance.instanceId);
    return {
      resourceKey: instance.resourceKey ?? instance.instanceId,
      instanceId: instance.instanceId,
      region: instance.region,
      instanceType: instance.instanceType ?? null,
      cpuP95Percent: profile.cpuP95Percent,
      networkP95BytesPerMinute: profile.networkP95BytesPerMinute,
      memoryP95Percent: profile.memoryP95Percent,
      sampleWindowDays: windowDays,
      datapointCount: Math.max(1, Math.round((windowDays * 86_400) / periodSeconds)),
    };
  });
  return {
    schemaVersion: "sutra.aws-utilization.v1",
    status: samples.length === 0 ? "UNAVAILABLE" : "COMPLETE",
    accountId: options.accountId,
    collectedAt: now.toISOString(),
    windowStartIso: windowStart.toISOString(),
    windowEndIso: windowEnd.toISOString(),
    windowDays,
    periodSeconds,
    samples,
    limitations: samples.length === 0 ? ["NO_EC2_INSTANCES_TO_SAMPLE"] : [],
    disclaimer: UTILIZATION_DISCLAIMER,
  };
}

interface FixtureProfile {
  readonly cpuP95Percent: number;
  readonly networkP95BytesPerMinute: number;
  readonly memoryP95Percent: number | null;
}

function fixtureProfile(instanceId: string): FixtureProfile {
  let hash = 0;
  for (let index = 0; index < instanceId.length; index += 1) {
    hash = (hash * 31 + instanceId.charCodeAt(index)) >>> 0;
  }
  switch (hash % 4) {
    case 0:
      // Confidently idle, memory not collected -> downsize candidate (mem-unknown disclosure).
      return { cpuP95Percent: 11, networkP95BytesPerMinute: 1_200_000, memoryP95Percent: null };
    case 1:
      // Busy -> already-optimal.
      return { cpuP95Percent: 68, networkP95BytesPerMinute: 42_000_000, memoryP95Percent: 40 };
    case 2:
      // Idle CPU but memory-bound (agent present) -> not downsized.
      return { cpuP95Percent: 14, networkP95BytesPerMinute: 900_000, memoryP95Percent: 74 };
    default:
      // Idle with agent-reported low memory -> downsize candidate (memory known).
      return { cpuP95Percent: 9, networkP95BytesPerMinute: 600_000, memoryP95Percent: 22 };
  }
}

/** Live collection: bounded, read-only CloudWatch reads for the supplied instances. */
export async function collectEc2Utilization(
  options: Ec2UtilizationCollectionOptions,
): Promise<Ec2UtilizationCollection> {
  const now = options.now?.() ?? new Date();
  const windowDays = clampWindowDays(options.windowDays);
  const periodSeconds = clampPeriodSeconds(options.periodSeconds);
  const windowEnd = now;
  const windowStart = new Date(windowEnd.getTime() - windowDays * 86_400_000);
  const readerFactory = options.readerFactory ?? createCloudWatchReader;

  const bounded = options.instances.slice(0, MAX_INSTANCES);
  const byRegion = new Map<string, CollectedEc2Instance[]>();
  for (const instance of bounded) {
    if (!REGION.test(instance.region)) continue;
    const group = byRegion.get(instance.region) ?? [];
    group.push(instance);
    byRegion.set(instance.region, group);
  }

  const samples: Ec2UtilizationSample[] = [];
  const limitations: string[] = [];
  if (bounded.length < options.instances.length) limitations.push("EC2_INSTANCE_SAMPLE_TRUNCATED_TO_LIMIT");
  let partial = false;

  const regions = [...byRegion.keys()].sort((a, b) => a.localeCompare(b, "en-US"));
  for (const region of regions) {
    const instances = byRegion.get(region) as CollectedEc2Instance[];
    const reader = readerFactory(region, options.credentials);
    let memoryInstrumented = new Set<string>();
    try {
      memoryInstrumented = await memoryInstrumentedInstances(
        reader,
        new Set(instances.map((instance) => instance.instanceId)),
      );
    } catch {
      partial = true;
      limitations.push(`MEMORY_METRIC_DISCOVERY_FAILED_${region}`);
    }

    for (const group of chunk(instances, INSTANCE_CHUNK)) {
      const queries: MetricDataQuery[] = [];
      group.forEach((instance, index) => {
        queries.push(ec2Query(`cpu_${index}`, CPU_METRIC, instance.instanceId, periodSeconds));
        queries.push(ec2Query(`nin_${index}`, NETWORK_IN_METRIC, instance.instanceId, periodSeconds));
        queries.push(ec2Query(`nout_${index}`, NETWORK_OUT_METRIC, instance.instanceId, periodSeconds));
        if (memoryInstrumented.has(instance.instanceId)) {
          queries.push(memoryQuery(`mem_${index}`, instance.instanceId, periodSeconds));
        }
      });
      let values: Map<string, (number | undefined)[]>;
      try {
        values = await readMetricData(reader, queries, windowStart, windowEnd);
      } catch {
        partial = true;
        limitations.push(`METRIC_DATA_FETCH_FAILED_${region}`);
        continue;
      }
      group.forEach((instance, index) => {
        const cpu = safeP95(values.get(`cpu_${index}`));
        const networkIn = safeP95(values.get(`nin_${index}`));
        const networkOut = safeP95(values.get(`nout_${index}`));
        const memory = memoryInstrumented.has(instance.instanceId)
          ? safeP95(values.get(`mem_${index}`))
          : { peak: null, count: 0 };
        const network = maxNullable(networkIn.peak, networkOut.peak);
        samples.push({
          resourceKey: instance.resourceKey ?? instance.instanceId,
          instanceId: instance.instanceId,
          region,
          instanceType: instance.instanceType ?? null,
          cpuP95Percent: cpu.peak,
          networkP95BytesPerMinute: network === null ? null : bytesPerPeriodToPerMinute(network, periodSeconds),
          memoryP95Percent: memory.peak,
          sampleWindowDays: windowDays,
          datapointCount: cpu.count,
        });
      });
    }
  }

  samples.sort((a, b) => a.resourceKey.localeCompare(b.resourceKey, "en-US"));
  const status: Ec2UtilizationStatus = samples.length === 0 ? "UNAVAILABLE" : partial ? "PARTIAL" : "COMPLETE";
  return {
    schemaVersion: "sutra.aws-utilization.v1",
    status,
    accountId: options.accountId,
    collectedAt: now.toISOString(),
    windowStartIso: windowStart.toISOString(),
    windowEndIso: windowEnd.toISOString(),
    windowDays,
    periodSeconds,
    samples,
    limitations,
    disclaimer: UTILIZATION_DISCLAIMER,
  };
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function bytesPerPeriodToPerMinute(bytesPerPeriod: number, periodSeconds: number): number {
  const minutes = periodSeconds / 60;
  return minutes > 0 ? bytesPerPeriod / minutes : bytesPerPeriod;
}
