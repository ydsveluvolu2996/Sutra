// Pure cost-optimization engine over already-collected evidence: the Cost
// Explorer snapshot plus the CMDB resource inventory. It derives actionable,
// evidence-honest recommendations — idle/stopped resources, spend anomalies,
// forecast overage, spend concentration, and cost-allocation tag gaps — and
// only attaches an estimated saving when it is genuinely derivable from the
// data. It never invents a savings number: true rightsizing needs utilization
// metrics (CloudWatch) that Sutra does not collect, so those are surfaced as
// candidates, not as fabricated dollar figures.
import type { AwsCostSnapshot } from "./cost-types.ts";
import type { PilotResource } from "./pilot-types.ts";

export type CostOptimizationCategory =
  | "idle-resource" | "spend-anomaly" | "forecast-overage" | "concentration" | "tag-coverage";
export type CostOptimizationSeverity = "low" | "medium" | "high";

export interface CostOptimization {
  readonly id: string;
  readonly category: CostOptimizationCategory;
  readonly severity: CostOptimizationSeverity;
  readonly title: string;
  readonly summary: string;
  /** Only set when derivable from the data; null otherwise (never fabricated). */
  readonly estimatedMonthlySavings: number | null;
  readonly evidence: Readonly<Record<string, string | number>>;
}

export interface CostOptimizationReport {
  readonly schema: "sutra.aws-cost-optimization.v1";
  readonly recommendations: readonly CostOptimization[];
  readonly summary: {
    readonly count: number;
    readonly high: number;
    readonly estimatedMonthlySavings: number | null;
    readonly resourcesAnalyzed: number;
  };
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

const DISCLAIMER =
  "Cost optimizations are derived from the collected Cost Explorer snapshot and " +
  "CMDB inventory only. Savings are shown only when derivable; right-sizing that " +
  "needs per-resource utilization (CloudWatch) is surfaced as a candidate without " +
  "an invented dollar figure. Review each item against the workload before acting.";

const LIMITATIONS: readonly string[] = [
  "NO_PER_RESOURCE_UTILIZATION_METRICS_COLLECTED",
  "SAVINGS_ESTIMATED_ONLY_WHEN_DERIVABLE_FROM_COLLECTED_DATA",
];

// Cost-allocation tags an org typically needs for chargeback/showback.
const ALLOCATION_TAGS = ["Environment", "environment", "Owner", "owner", "CostCenter", "cost-center", "Team", "team"];

function isStopped(resource: PilotResource): boolean {
  return /^(stopped|shutting-down|deallocated|stopping)$/iu.test(resource.state);
}

function hasAllocationTag(resource: PilotResource): boolean {
  return ALLOCATION_TAGS.some((tag) => typeof resource.tags[tag] === "string" && resource.tags[tag].length > 0);
}

function isBillable(resource: PilotResource): boolean {
  // Heuristic: compute/storage/db resources carry recurring cost; IAM/SG/subnet metadata does not.
  return /(ec2|rds|elasticloadbalancing|elb|dynamodb|s3|ecr|eks|elasticache|redshift|lambda|ebs|volume)/iu.test(
    `${resource.service} ${resource.resourceType}`,
  );
}

export function buildCostOptimizations(input: {
  readonly snapshot: AwsCostSnapshot | null;
  readonly resources: readonly PilotResource[];
}): CostOptimizationReport {
  const recommendations: CostOptimization[] = [];
  const resources = input.resources;
  const snapshot = input.snapshot;

  // 1. Idle / stopped billable resources (e.g. stopped EC2 still incurring EBS).
  const stopped = resources.filter((resource) => isStopped(resource) && isBillable(resource));
  if (stopped.length > 0) {
    recommendations.push({
      id: "idle-stopped-resources",
      category: "idle-resource",
      severity: stopped.length >= 5 ? "high" : "medium",
      title: `${stopped.length} stopped billable resource${stopped.length === 1 ? "" : "s"}`,
      summary: "Stopped compute still incurs attached-storage and reserved-address cost. Terminate or snapshot-and-delete if no longer needed.",
      estimatedMonthlySavings: null, // no per-resource cost without a cost/usage report
      evidence: { stoppedResources: stopped.length, examples: stopped.slice(0, 3).map((r) => r.name ?? r.nativeId).join(", ") },
    });
  }

  // 2. Spend anomaly — month-over-month total spike.
  if (snapshot?.trendPercent !== null && snapshot?.trendPercent !== undefined && snapshot.trendPercent >= 25 && snapshot.previousMonthCost !== null) {
    const delta = Math.max(0, snapshot.monthToDateCost - snapshot.previousMonthCost);
    recommendations.push({
      id: "spend-anomaly-trend",
      category: "spend-anomaly",
      severity: snapshot.trendPercent >= 60 ? "high" : "medium",
      title: `Spend is up ${Math.round(snapshot.trendPercent)}% versus last month`,
      summary: "Month-over-month spend rose sharply. Investigate the top-growing service and confirm it is intended.",
      estimatedMonthlySavings: null,
      evidence: { trendPercent: Math.round(snapshot.trendPercent), monthToDate: Math.round(snapshot.monthToDateCost), previousMonth: Math.round(snapshot.previousMonthCost), deltaSoFar: Math.round(delta) },
    });
  }

  // 3. Forecast overage — projected month-end exceeds last month by >10%.
  if (snapshot?.forecast.amount !== null && snapshot?.forecast.amount !== undefined && snapshot.previousMonthCost !== null && snapshot.forecast.amount > snapshot.previousMonthCost * 1.1) {
    const overage = snapshot.forecast.amount - snapshot.previousMonthCost;
    recommendations.push({
      id: "forecast-overage",
      category: "forecast-overage",
      severity: snapshot.forecast.amount > snapshot.previousMonthCost * 1.3 ? "high" : "medium",
      title: "Forecast exceeds last month's spend",
      summary: "The projected month-end total is materially above last month. Set a budget/alert and review the growth driver.",
      estimatedMonthlySavings: Math.round(overage), // the derivable overage vs a flat month
      evidence: { forecast: Math.round(snapshot.forecast.amount), previousMonth: Math.round(snapshot.previousMonthCost), projectedOverage: Math.round(overage), forecastSource: snapshot.forecast.source },
    });
  }

  // 4. Spend concentration — a single service dominates the bill.
  const topService = snapshot?.serviceBreakdown[0];
  if (topService !== undefined && topService.sharePercent >= 45) {
    recommendations.push({
      id: "spend-concentration",
      category: "concentration",
      severity: topService.sharePercent >= 70 ? "medium" : "low",
      title: `${topService.label} is ${Math.round(topService.sharePercent)}% of spend`,
      summary: "A dominant service concentrates both cost and optimization leverage. Prioritize commitment-discount and right-sizing review there.",
      estimatedMonthlySavings: null,
      evidence: { service: topService.label, sharePercent: Math.round(topService.sharePercent), amount: Math.round(topService.amount) },
    });
  }

  // 5. Cost-allocation tag coverage — untagged billable resources hurt chargeback.
  const billable = resources.filter(isBillable);
  const untagged = billable.filter((resource) => !hasAllocationTag(resource));
  if (billable.length > 0 && untagged.length / billable.length >= 0.2) {
    recommendations.push({
      id: "tag-coverage",
      category: "tag-coverage",
      severity: untagged.length / billable.length >= 0.5 ? "medium" : "low",
      title: `${untagged.length} of ${billable.length} billable resources lack a cost-allocation tag`,
      summary: "Without Environment/Owner/CostCenter tags, spend can't be attributed for showback/chargeback or budget enforcement.",
      estimatedMonthlySavings: null,
      evidence: { untagged: untagged.length, billable: billable.length, coveragePercent: Math.round(100 * (1 - untagged.length / billable.length)) },
    });
  }

  const rank: Readonly<Record<CostOptimizationSeverity, number>> = { high: 0, medium: 1, low: 2 };
  recommendations.sort((left, right) => rank[left.severity] - rank[right.severity] || left.id.localeCompare(right.id, "en-US"));

  const savings = recommendations.map((rec) => rec.estimatedMonthlySavings).filter((value): value is number => value !== null);
  return {
    schema: "sutra.aws-cost-optimization.v1",
    recommendations,
    summary: {
      count: recommendations.length,
      high: recommendations.filter((rec) => rec.severity === "high").length,
      estimatedMonthlySavings: savings.length > 0 ? savings.reduce((sum, value) => sum + value, 0) : null,
      resourcesAnalyzed: resources.length,
    },
    limitations: LIMITATIONS,
    disclaimer: DISCLAIMER,
  };
}
