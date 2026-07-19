import { parseAwsAccountId } from "./aws-pilot-security.ts";
import type {
  AwsCostSnapshot,
  CostBreakdownItem,
  CostRecommendation,
  CostSignal,
} from "./cost-types.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const MONEY_LIMIT = 1_000_000_000_000;

export class CostBoundaryError extends Error {
  public readonly code = "BROKER_RESPONSE_INVALID";

  public constructor() {
    super("The collector returned cost data that failed Sutra validation");
    this.name = "CostBoundaryError";
  }
}

function invalid(): never {
  throw new CostBoundaryError();
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || Object.keys(result).some((key) => !keys.includes(key))) invalid();
  return result;
}

function string(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > maximum ||
    value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)
  ) invalid();
  return value;
}

function nullableString(value: unknown, maximum: number, pattern?: RegExp): string | null {
  if (value === null) return null;
  const parsed = string(value, maximum);
  if (pattern !== undefined && !pattern.test(parsed)) invalid();
  return parsed;
}

function amount(value: unknown, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MONEY_LIMIT) invalid();
  return value;
}

function percentage(value: unknown, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < -100 || value > 1_000_000) invalid();
  return value;
}

function isoDate(value: unknown): string {
  const parsed = string(value, 10);
  if (!ISO_DATE.test(parsed) || Number.isNaN(Date.parse(`${parsed}T00:00:00.000Z`))) invalid();
  return parsed;
}

function timestamp(value: unknown): string {
  const parsed = string(value, 40);
  const millis = Date.parse(parsed);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== parsed || millis > Date.now() + 300_000) invalid();
  return parsed;
}

function evidence(value: unknown): Readonly<Record<string, string | number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 12) invalid();
  const result: Record<string, string | number> = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(key)) invalid();
    if (typeof item === "string") result[key] = string(item, 256);
    else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else invalid();
  }
  return result;
}

function breakdown(value: unknown): readonly CostBreakdownItem[] {
  if (!Array.isArray(value) || value.length > 30) invalid();
  return value.map((item) => {
    const parsed = record(item, ["key", "label", "amount", "sharePercent"]);
    return {
      key: string(parsed.key, 256),
      label: string(parsed.label, 300),
      amount: amount(parsed.amount) as number,
      sharePercent: percentage(parsed.sharePercent) as number,
    };
  });
}

function signals(value: unknown): readonly CostSignal[] {
  if (!Array.isArray(value) || value.length > 10) invalid();
  return value.map((item) => {
    const parsed = record(item, ["id", "severity", "title", "summary", "evidence"]);
    if (!new Set(["low", "medium", "high"]).has(parsed.severity as string)) invalid();
    return {
      id: string(parsed.id, 400),
      severity: parsed.severity as CostSignal["severity"],
      title: string(parsed.title, 200),
      summary: string(parsed.summary, 500),
      evidence: evidence(parsed.evidence),
    };
  });
}

function recommendations(value: unknown): readonly CostRecommendation[] {
  if (!Array.isArray(value) || value.length > 10) invalid();
  return value.map((item) => {
    const parsed = record(item, ["id", "category", "title", "summary", "evidence"]);
    if (!new Set(["growth", "concentration"]).has(parsed.category as string)) invalid();
    return {
      id: string(parsed.id, 400),
      category: parsed.category as CostRecommendation["category"],
      title: string(parsed.title, 200),
      summary: string(parsed.summary, 500),
      evidence: evidence(parsed.evidence),
    };
  });
}

export function parseAwsCostSnapshot(value: unknown, expectedAccountId: string): AwsCostSnapshot {
  const parsed = record(value, [
    "schemaVersion", "status", "accountId", "currency", "collectedAt", "periodStart", "periodEnd",
    "totalCost", "monthToDateCost", "previousMonthCost", "trendPercent", "monthlyTrend",
    "serviceBreakdown", "accountBreakdown", "forecast", "anomalies", "recommendations", "limitations",
    "unavailableReason",
  ]);
  if (parsed.schemaVersion !== "sutra.aws-costs.v1") invalid();
  if (!new Set(["COMPLETE", "PARTIAL", "UNAVAILABLE"]).has(parsed.status as string)) invalid();
  const accountId = parseAwsAccountId(parsed.accountId);
  if (accountId !== expectedAccountId) invalid();
  if (parsed.currency !== "USD") invalid();
  if (!Array.isArray(parsed.monthlyTrend) || parsed.monthlyTrend.length > 12) invalid();
  if (!Array.isArray(parsed.limitations) || parsed.limitations.length > 20) invalid();
  const forecast = record(parsed.forecast, ["status", "source", "amount", "periodStart", "periodEnd", "reasonCode"]);
  if (!new Set(["AVAILABLE", "FALLBACK", "UNAVAILABLE"]).has(forecast.status as string)) invalid();
  if (!new Set(["AWS_COST_EXPLORER", "SUTRA_LINEAR_PROJECTION", "NONE"]).has(forecast.source as string)) invalid();
  return {
    schemaVersion: "sutra.aws-costs.v1",
    status: parsed.status as AwsCostSnapshot["status"],
    accountId,
    currency: "USD",
    collectedAt: timestamp(parsed.collectedAt),
    periodStart: isoDate(parsed.periodStart),
    periodEnd: isoDate(parsed.periodEnd),
    totalCost: amount(parsed.totalCost) as number,
    monthToDateCost: amount(parsed.monthToDateCost) as number,
    previousMonthCost: amount(parsed.previousMonthCost, true),
    trendPercent: percentage(parsed.trendPercent, true),
    monthlyTrend: parsed.monthlyTrend.map((item) => {
      const point = record(item, ["start", "end", "amount"]);
      return { start: isoDate(point.start), end: isoDate(point.end), amount: amount(point.amount) as number };
    }),
    serviceBreakdown: breakdown(parsed.serviceBreakdown),
    accountBreakdown: breakdown(parsed.accountBreakdown),
    forecast: {
      status: forecast.status as AwsCostSnapshot["forecast"]["status"],
      source: forecast.source as AwsCostSnapshot["forecast"]["source"],
      amount: amount(forecast.amount, true),
      periodStart: isoDate(forecast.periodStart),
      periodEnd: isoDate(forecast.periodEnd),
      reasonCode: nullableString(forecast.reasonCode, 96, SAFE_CODE),
    },
    anomalies: signals(parsed.anomalies),
    recommendations: recommendations(parsed.recommendations),
    limitations: parsed.limitations.map((item) => string(item, 160)),
    unavailableReason: nullableString(parsed.unavailableReason, 96, SAFE_CODE),
  };
}
