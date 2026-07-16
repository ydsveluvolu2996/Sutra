import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostForecastCommand,
  type GetCostAndUsageCommandInput,
  type GetCostAndUsageCommandOutput,
  type GetCostForecastCommandInput,
  type GetCostForecastCommandOutput,
} from "@aws-sdk/client-cost-explorer";

import type { AwsPartition, AwsTemporaryCredentials } from "./types.js";
import { workloadIdentityAwsClientConfig } from "./role-broker.js";

const MAX_PAGES = 20;
const MAX_BREAKDOWN_ITEMS = 30;
const MAX_AMOUNT = 1_000_000_000_000;

export type CostCollectionStatus = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";

export interface CostAmountPoint {
  readonly start: string;
  readonly end: string;
  readonly amount: number;
}

export interface CostBreakdownItem {
  readonly key: string;
  readonly label: string;
  readonly amount: number;
  readonly sharePercent: number;
}

export interface CostSignal {
  readonly id: string;
  readonly severity: "low" | "medium" | "high";
  readonly title: string;
  readonly summary: string;
  readonly evidence: Readonly<Record<string, string | number>>;
}

export interface CostRecommendation {
  readonly id: string;
  readonly category: "growth" | "concentration";
  readonly title: string;
  readonly summary: string;
  readonly evidence: Readonly<Record<string, string | number>>;
}

export interface AwsCostSnapshot {
  readonly schemaVersion: "sutra.aws-costs.v1";
  readonly status: CostCollectionStatus;
  readonly accountId: string;
  readonly currency: string;
  readonly collectedAt: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly totalCost: number;
  readonly monthToDateCost: number;
  readonly previousMonthCost: number | null;
  readonly trendPercent: number | null;
  readonly monthlyTrend: readonly CostAmountPoint[];
  readonly serviceBreakdown: readonly CostBreakdownItem[];
  readonly accountBreakdown: readonly CostBreakdownItem[];
  readonly forecast: {
    readonly status: "AVAILABLE" | "FALLBACK" | "UNAVAILABLE";
    readonly source: "AWS_COST_EXPLORER" | "SUTRA_LINEAR_PROJECTION" | "NONE";
    readonly amount: number | null;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly reasonCode: string | null;
  };
  readonly anomalies: readonly CostSignal[];
  readonly recommendations: readonly CostRecommendation[];
  readonly limitations: readonly string[];
  readonly unavailableReason: string | null;
}

export interface CostExplorerReader {
  getCostAndUsage(
    input: GetCostAndUsageCommandInput,
  ): Promise<Pick<GetCostAndUsageCommandOutput, "ResultsByTime" | "NextPageToken">>;
  getCostForecast(
    input: GetCostForecastCommandInput,
  ): Promise<Pick<GetCostForecastCommandOutput, "Total">>;
}

export interface AwsCostCollectionOptions {
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly credentials: AwsTemporaryCredentials;
  readonly now?: () => Date;
  readonly client?: CostExplorerReader;
}

interface PeriodGroup {
  readonly start: string;
  readonly end: string;
  readonly total: number;
  readonly groups: ReadonlyMap<string, number>;
}

export async function collectAwsCosts(
  options: AwsCostCollectionOptions,
): Promise<AwsCostSnapshot> {
  const now = options.now?.() ?? new Date();
  const collectedAt = now.toISOString();
  // Cost Explorer usage End is exclusive and must not be in the future.
  const periodEnd = isoDate(now);
  const periodStart = isoDate(addUtcMonths(startOfUtcMonth(now), -5));
  const currentStart = isoDate(startOfUtcMonth(now));
  const nextMonthStart = isoDate(addUtcMonths(startOfUtcMonth(now), 1));
  if (options.partition !== "aws") {
    return unavailableSnapshot(options.accountId, collectedAt, periodStart, periodEnd, currentStart, nextMonthStart, "UNSUPPORTED_PARTITION");
  }

  const client = options.client ?? createCostExplorerReader(options.credentials);
  let services: readonly PeriodGroup[];
  try {
    services = await readGroupedCosts(client, periodStart, periodEnd, "SERVICE");
  } catch (error) {
    return unavailableSnapshot(
      options.accountId,
      collectedAt,
      periodStart,
      periodEnd,
      currentStart,
      nextMonthStart,
      publicCostErrorCode(error),
    );
  }

  const limitations: string[] = [];
  let accounts: readonly PeriodGroup[] = [];
  try {
    accounts = await readGroupedCosts(client, periodStart, periodEnd, "LINKED_ACCOUNT");
  } catch (error) {
    limitations.push(`ACCOUNT_BREAKDOWN_${publicCostErrorCode(error)}`);
  }

  const current = services.find((period) => period.start === currentStart) ?? null;
  const previousStart = isoDate(addUtcMonths(startOfUtcMonth(now), -1));
  const previous = services.find((period) => period.start === previousStart) ?? null;
  const totalCost = roundMoney(services.reduce((sum, period) => sum + period.total, 0));
  const monthToDateCost = roundMoney(current?.total ?? 0);
  const previousMonthCost = previous === null ? null : roundMoney(previous.total);
  const trendPercent = previousMonthCost !== null && previousMonthCost > 0
    ? roundPercent(((monthToDateCost - previousMonthCost) / previousMonthCost) * 100)
    : null;

  const serviceBreakdown = breakdown(current?.groups ?? new Map(), monthToDateCost, "service");
  const currentAccounts = accounts.find((period) => period.start === currentStart)?.groups ?? new Map();
  const accountBreakdown = breakdown(currentAccounts, sumMap(currentAccounts), "account");
  const forecast = await collectForecast(client, now, currentStart, nextMonthStart, monthToDateCost);
  if (forecast.status !== "AVAILABLE") limitations.push(`FORECAST_${forecast.reasonCode ?? forecast.status}`);

  const anomalies = deriveAnomalies(services, now);
  const recommendations = deriveRecommendations(serviceBreakdown, previousMonthCost, monthToDateCost, trendPercent);
  return {
    schemaVersion: "sutra.aws-costs.v1",
    status: limitations.length === 0 ? "COMPLETE" : "PARTIAL",
    accountId: options.accountId,
    currency: "USD",
    collectedAt,
    periodStart,
    periodEnd,
    totalCost,
    monthToDateCost,
    previousMonthCost,
    trendPercent,
    monthlyTrend: services.map((period) => ({ start: period.start, end: period.end, amount: roundMoney(period.total) })),
    serviceBreakdown,
    accountBreakdown,
    forecast,
    anomalies,
    recommendations,
    limitations,
    unavailableReason: null,
  };
}

function createCostExplorerReader(credentials: AwsTemporaryCredentials): CostExplorerReader {
  const client = new CostExplorerClient({
    ...workloadIdentityAwsClientConfig("us-east-1", 3),
    credentials,
  });
  return {
    getCostAndUsage: (input) => client.send(new GetCostAndUsageCommand(input)),
    getCostForecast: (input) => client.send(new GetCostForecastCommand(input)),
  };
}

async function readGroupedCosts(
  client: CostExplorerReader,
  start: string,
  end: string,
  dimension: "SERVICE" | "LINKED_ACCOUNT",
): Promise<readonly PeriodGroup[]> {
  const byPeriod = new Map<string, { start: string; end: string; groups: Map<string, number> }>();
  let nextPageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.getCostAndUsage({
      TimePeriod: { Start: start, End: end },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: dimension }],
      ...(nextPageToken === undefined ? {} : { NextPageToken: nextPageToken }),
    });
    for (const result of output.ResultsByTime ?? []) {
      const periodStart = result.TimePeriod?.Start;
      const periodEnd = result.TimePeriod?.End;
      if (!isIsoDate(periodStart) || !isIsoDate(periodEnd)) continue;
      const key = `${periodStart}\u0000${periodEnd}`;
      const record = byPeriod.get(key) ?? { start: periodStart, end: periodEnd, groups: new Map<string, number>() };
      for (const group of result.Groups ?? []) {
        const groupKey = group.Keys?.[0];
        if (typeof groupKey !== "string" || groupKey.length === 0 || groupKey.length > 256) continue;
        const amount = safeAmount(group.Metrics?.UnblendedCost?.Amount);
        record.groups.set(groupKey, (record.groups.get(groupKey) ?? 0) + amount);
      }
      byPeriod.set(key, record);
    }
    nextPageToken = output.NextPageToken;
    if (nextPageToken === undefined || nextPageToken.length === 0) break;
    if (page === MAX_PAGES - 1) throw Object.assign(new Error("Cost data exceeded the bounded page limit"), { name: "PageLimitExceeded" });
  }
  return [...byPeriod.values()]
    .sort((left, right) => left.start.localeCompare(right.start))
    .map((period) => ({ ...period, total: sumMap(period.groups) }));
}

async function collectForecast(
  client: CostExplorerReader,
  now: Date,
  currentStart: string,
  nextMonthStart: string,
  monthToDateCost: number,
): Promise<AwsCostSnapshot["forecast"]> {
  const tomorrow = isoDate(addUtcDays(now, 1));
  if (tomorrow < nextMonthStart) {
    try {
      const output = await client.getCostForecast({
        TimePeriod: { Start: tomorrow, End: nextMonthStart },
        Granularity: "DAILY",
        Metric: "UNBLENDED_COST",
      });
      const remaining = safeAmount(output.Total?.Amount);
      return {
        status: "AVAILABLE",
        source: "AWS_COST_EXPLORER",
        amount: roundMoney(monthToDateCost + remaining),
        periodStart: currentStart,
        periodEnd: nextMonthStart,
        reasonCode: null,
      };
    } catch (error) {
      const fallback = linearProjection(now, monthToDateCost);
      return {
        status: fallback === null ? "UNAVAILABLE" : "FALLBACK",
        source: fallback === null ? "NONE" : "SUTRA_LINEAR_PROJECTION",
        amount: fallback,
        periodStart: currentStart,
        periodEnd: nextMonthStart,
        reasonCode: publicCostErrorCode(error),
      };
    }
  }
  return {
    status: "FALLBACK",
    source: "SUTRA_LINEAR_PROJECTION",
    amount: monthToDateCost,
    periodStart: currentStart,
    periodEnd: nextMonthStart,
    reasonCode: "MONTH_END",
  };
}

function deriveAnomalies(periods: readonly PeriodGroup[], now: Date): readonly CostSignal[] {
  const currentStart = isoDate(startOfUtcMonth(now));
  const closed = periods.filter((period) => period.start < currentStart);
  if (closed.length < 2) return [];
  const latest = closed.at(-1)!;
  const previous = closed.at(-2)!;
  const keys = new Set([...latest.groups.keys(), ...previous.groups.keys()]);
  const signals: CostSignal[] = [];
  for (const key of keys) {
    const currentAmount = latest.groups.get(key) ?? 0;
    const previousAmount = previous.groups.get(key) ?? 0;
    const delta = currentAmount - previousAmount;
    const increase = previousAmount > 0 ? (delta / previousAmount) * 100 : null;
    if (delta < 5 || increase === null || increase < 50) continue;
    signals.push({
      id: `service-spike:${key}:${latest.start}`,
      severity: increase >= 150 && delta >= 50 ? "high" : increase >= 80 ? "medium" : "low",
      title: `${key} spend increased`,
      summary: `Closed-month spend increased ${roundPercent(increase)}% compared with the preceding month.`,
      evidence: {
        service: key,
        period: latest.start,
        currentAmount: roundMoney(currentAmount),
        previousAmount: roundMoney(previousAmount),
        delta: roundMoney(delta),
      },
    });
  }
  return signals.sort((left, right) => Number(right.evidence.delta) - Number(left.evidence.delta)).slice(0, 10);
}

function deriveRecommendations(
  services: readonly CostBreakdownItem[],
  previousMonthCost: number | null,
  monthToDateCost: number,
  trendPercent: number | null,
): readonly CostRecommendation[] {
  const recommendations: CostRecommendation[] = [];
  const largest = services[0];
  if (largest !== undefined && largest.amount >= 20 && largest.sharePercent >= 50) {
    recommendations.push({
      id: `concentration:${largest.key}`,
      category: "concentration",
      title: `Review ${largest.label} cost concentration`,
      summary: "Start optimization review with the largest current-month service; Sutra has not assumed that spend is waste.",
      evidence: { service: largest.label, amount: largest.amount, sharePercent: largest.sharePercent },
    });
  }
  if (previousMonthCost !== null && trendPercent !== null && trendPercent >= 15 && monthToDateCost - previousMonthCost >= 5) {
    recommendations.push({
      id: "growth:month-to-date",
      category: "growth",
      title: "Investigate current-month cost growth",
      summary: "Current month-to-date cost is already above the previous closed month; validate whether the growth is expected.",
      evidence: { monthToDateCost, previousMonthCost, trendPercent },
    });
  }
  return recommendations;
}

function breakdown(
  groups: ReadonlyMap<string, number>,
  total: number,
  kind: "service" | "account",
): readonly CostBreakdownItem[] {
  return [...groups.entries()]
    .filter(([, amount]) => amount > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_BREAKDOWN_ITEMS)
    .map(([key, amount]) => ({
      key,
      label: kind === "account" ? `AWS account ${key}` : key,
      amount: roundMoney(amount),
      sharePercent: total > 0 ? roundPercent((amount / total) * 100) : 0,
    }));
}

function unavailableSnapshot(
  accountId: string,
  collectedAt: string,
  periodStart: string,
  periodEnd: string,
  currentStart: string,
  nextMonthStart: string,
  reason: string,
): AwsCostSnapshot {
  return {
    schemaVersion: "sutra.aws-costs.v1",
    status: "UNAVAILABLE",
    accountId,
    currency: "USD",
    collectedAt,
    periodStart,
    periodEnd,
    totalCost: 0,
    monthToDateCost: 0,
    previousMonthCost: null,
    trendPercent: null,
    monthlyTrend: [],
    serviceBreakdown: [],
    accountBreakdown: [],
    forecast: { status: "UNAVAILABLE", source: "NONE", amount: null, periodStart: currentStart, periodEnd: nextMonthStart, reasonCode: reason },
    anomalies: [],
    recommendations: [],
    limitations: [reason],
    unavailableReason: reason,
  };
}

function publicCostErrorCode(error: unknown): string {
  const name = typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
    ? error.name
    : "UnknownError";
  if (new Set(["AccessDenied", "AccessDeniedException", "UnauthorizedException"]).has(name)) return "ACCESS_DENIED";
  if (new Set(["DataUnavailableException", "BillExpirationException"]).has(name)) return "BILLING_DATA_UNAVAILABLE";
  if (new Set(["ThrottlingException", "LimitExceededException", "RequestTimeout"]).has(name)) return "TEMPORARILY_UNAVAILABLE";
  if (name === "PageLimitExceeded") return "PAGE_LIMIT_EXCEEDED";
  return "COLLECTION_FAILED";
}

function safeAmount(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < -MAX_AMOUNT || parsed > MAX_AMOUNT) return 0;
  return Math.max(0, parsed);
}

function sumMap(values: ReadonlyMap<string, number>): number {
  return [...values.values()].reduce((sum, value) => sum + value, 0);
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundPercent(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function linearProjection(now: Date, amount: number): number | null {
  const elapsed = now.getUTCDate();
  const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return elapsed > 0 ? roundMoney((amount / elapsed) * days) : null;
}

function startOfUtcMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function addUtcMonths(value: Date, months: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}
