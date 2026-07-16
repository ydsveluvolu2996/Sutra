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

export interface StoredCostSnapshot {
  readonly id: string;
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly payload: AwsCostSnapshot;
  readonly payloadSha256: string;
  readonly collectedAt: string;
  readonly createdAt: string;
}
