// Pure cost-optimization engine over already-collected evidence: the Cost
// Explorer snapshot, the CMDB resource inventory, and (when supplied) the
// ingested CUR/FOCUS billing line items. It derives actionable,
// evidence-honest recommendations — idle/stopped resources, spend anomalies,
// forecast overage, spend concentration, cost-allocation tag gaps, plus
// commitment (RI/Savings Plan) and rightsizing candidates — and only attaches
// an estimated saving when it is genuinely derivable from the data. It never
// invents a savings number: true rightsizing needs utilization metrics
// (CloudWatch) that Sutra does not collect, so those are surfaced as
// candidates, not as fabricated dollar figures; commitment savings are shown
// only against observed sustained on-demand spend and only with a disclosed,
// assumed public discount rate that is labeled an input, never a quote.
import type { AwsCostSnapshot } from "./cost-types.ts";
import type { NormalizedCurLine } from "./finops-cur.ts";
import type { PilotResource } from "./pilot-types.ts";

export type CostOptimizationCategory =
  | "idle-resource" | "spend-anomaly" | "forecast-overage" | "concentration" | "tag-coverage"
  | "commitment" | "rightsizing";
export type CostOptimizationSeverity = "low" | "medium" | "high";

export interface CostOptimization {
  readonly id: string;
  readonly category: CostOptimizationCategory;
  readonly severity: CostOptimizationSeverity;
  readonly title: string;
  readonly summary: string;
  /**
   * Whole-currency-unit saving for the snapshot-derived categories only; null
   * otherwise (never fabricated). CUR-derived categories (commitment,
   * rightsizing) always leave this null and use `estimatedMonthlySavingsMicros`
   * instead, because CUR money is integer micro-units and carries its own
   * currency (mixed currencies are never summed into a single scalar).
   */
  readonly estimatedMonthlySavings: number | null;
  /** ISO 4217 code for CUR-derived recommendations; absent for snapshot ones. */
  readonly currency?: string;
  /**
   * Micro-unit (bigint-safe decimal string) saving for CUR-derived
   * recommendations. `null` means no saving is derivable and the reason is
   * disclosed in `evidence`. Rightsizing is ALWAYS null (utilization not
   * collected). Absent for snapshot-derived recommendations.
   */
  readonly estimatedMonthlySavingsMicros?: string | null;
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
    readonly curLinesAnalyzed: number;
    /**
     * Commitment savings totalled per currency in micro-units — never summed
     * across currencies into one number. Empty when no commitment saving is
     * derivable.
     */
    readonly commitmentSavingsByCurrencyMicros: Readonly<Record<string, string>>;
  };
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

const DISCLAIMER =
  "Cost optimizations are derived from the collected Cost Explorer snapshot, " +
  "CMDB inventory, and ingested CUR/FOCUS billing lines only. Savings are shown " +
  "only when derivable; right-sizing that needs per-resource utilization " +
  "(CloudWatch) is surfaced as a candidate without an invented dollar figure. " +
  "Commitment savings apply a disclosed assumed discount rate to observed " +
  "sustained on-demand spend and are a planning input, not a quote. Review each " +
  "item against the workload before acting.";

// Conservative, publicly documented assumption used for commitment savings:
// a 1-year no-upfront Compute Savings Plan typically discounts on-demand
// compute by well over this; 20% is a deliberate floor so the estimate never
// overstates. Expressed in basis points for exact integer (bigint) math.
const COMMITMENT_ASSUMED_DISCOUNT_BP = 2000; // 20.00%

export const COMMITMENT_DISCOUNT_DISCLOSURE =
  "Estimated commitment savings apply an ASSUMED conservative 20% (1-year, " +
  "no-upfront Compute Savings Plan) discount to observed sustained on-demand " +
  "spend. This rate is a planning INPUT, not a quote or guarantee: actual " +
  "Savings Plan / Reserved Instance rates depend on term, payment option, " +
  "instance family, and region. Verify in the AWS Pricing Calculator before " +
  "purchasing any commitment.";

const LIMITATIONS: readonly string[] = [
  "NO_PER_RESOURCE_UTILIZATION_METRICS_COLLECTED",
  "SAVINGS_ESTIMATED_ONLY_WHEN_DERIVABLE_FROM_COLLECTED_DATA",
  "COMMITMENT_SAVINGS_USE_ASSUMED_DISCOUNT_RATE_NOT_A_QUOTE",
  "RIGHTSIZING_SAVINGS_ALWAYS_NULL_UTILIZATION_NOT_COLLECTED",
];

// Steady-state / commitment tuning. All thresholds are documented and applied
// over the OBSERVED usage window in the CUR data (no wall-clock dependency, so
// the engine is fully deterministic for a given input).
const COMMITMENT_MIN_WINDOW_DAYS = 2; // need >1 distinct day to speak of "sustained"
const STEADY_COVERAGE = 0.6; // on-demand usage must appear on >= 60% of window days
const COMMITMENT_MIN_ONDEMAND_MICROS = BigInt(10_000_000); // ignore < 10-unit noise
const RIGHTSIZE_MIN_ONDEMAND_MICROS = BigInt(1_000_000); // rightsizing targets can be small
const RIGHTSIZE_FLAT_RATIO_BP = 15_000; // maxDaily <= 1.5x minDaily counts as "flat"

const REASON_COMMITMENT_GRANULARITY =
  "COMMITMENT_DISCOUNT_REQUIRES_USAGE_TYPE_AND_INSTANCE_FAMILY_NOT_COLLECTED";
const REASON_RIGHTSIZE_UTILIZATION = "RIGHTSIZING_REQUIRES_UTILIZATION_NOT_COLLECTED";

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

// On-demand usage is the un-committed usage charge. In CUR 2.0 the line-item
// type "Usage" already EXCLUDES DiscountedUsage/SavingsPlanCoveredUsage, so it
// is genuinely on-demand; in FOCUS "Usage" is the closest available signal.
function isOnDemandUsage(line: NormalizedCurLine): boolean {
  return line.chargeCategory.trim().toLowerCase() === "usage";
}

// Services a Compute Savings Plan covers with a broadly applicable published
// rate — savings can be estimated against aggregate on-demand compute spend
// WITHOUT per-instance-family granularity.
function isComputeSavingsPlanEligible(service: string): boolean {
  return /(amazonec2|elastic compute cloud|(^|[^a-z])ec2([^a-z]|$)|fargate|awslambda|aws lambda|(^|[^a-z])lambda)/iu.test(service);
}

// Services where a commitment vehicle exists (Reserved Instances / reserved
// capacity) but the applicable discount depends on instance family / engine /
// usage-type that the normalized CUR line does NOT carry. These emit a
// candidate WITHOUT a savings number, with the granularity gap disclosed.
function isReservedCapacityEligible(service: string): boolean {
  return /(rds|relational database|redshift|elasticache|opensearch|elasticsearch|dynamodb)/iu.test(service);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || "unknown";
}

interface ServiceUsage {
  readonly service: string;
  micros: bigint;
  readonly days: Set<string>;
  readonly daily: Map<string, bigint>;
}

interface CommitmentBuildResult {
  readonly recommendations: readonly CostOptimization[];
  readonly savingsByCurrencyMicros: Readonly<Record<string, string>>;
}

/**
 * Commitment (RI / Savings Plan) and rightsizing candidates from ingested CUR
 * line items. Per-currency throughout — currencies are never summed together.
 * Savings are attached ONLY where derivable from a disclosed assumption; every
 * other candidate carries a null saving and a disclosed reason.
 */
function buildCommitmentAndRightsizing(curLines: readonly NormalizedCurLine[]): CommitmentBuildResult {
  const recommendations: CostOptimization[] = [];
  const savingsByCurrencyMicros: Record<string, bigint> = {};

  // Group on-demand usage per currency, then per service, tracking daily spend.
  const byCurrency = new Map<string, Map<string, ServiceUsage>>();
  const windowDaysByCurrency = new Map<string, Set<string>>();
  for (const line of curLines) {
    if (!isOnDemandUsage(line)) continue;
    const amount = BigInt(line.amountMicros);
    if (amount <= BigInt(0)) continue; // credits/negations are not on-demand spend
    const day = line.usageStartIso.slice(0, 10);
    const services = byCurrency.get(line.currency) ?? new Map<string, ServiceUsage>();
    byCurrency.set(line.currency, services);
    const window = windowDaysByCurrency.get(line.currency) ?? new Set<string>();
    window.add(day);
    windowDaysByCurrency.set(line.currency, window);
    const usage = services.get(line.service) ?? { service: line.service, micros: BigInt(0), days: new Set<string>(), daily: new Map<string, bigint>() };
    usage.micros += amount;
    usage.days.add(day);
    usage.daily.set(day, (usage.daily.get(day) ?? BigInt(0)) + amount);
    services.set(line.service, usage);
  }

  const currencies = [...byCurrency.keys()].sort((a, b) => a.localeCompare(b, "en-US"));
  for (const currency of currencies) {
    const services = byCurrency.get(currency) as Map<string, ServiceUsage>;
    const windowDays = (windowDaysByCurrency.get(currency) as Set<string>).size;
    if (windowDays < COMMITMENT_MIN_WINDOW_DAYS) continue;
    const totalOnDemand = [...services.values()].reduce((sum, usage) => sum + usage.micros, BigInt(0));

    for (const usage of [...services.values()].sort((a, b) => a.service.localeCompare(b.service, "en-US"))) {
      const coverage = usage.days.size / windowDays;
      if (coverage < STEADY_COVERAGE) continue; // not sustained across the observed window
      const coveragePercent = Math.round(coverage * 100);
      const sharePercent = totalOnDemand > BigInt(0)
        ? Number((usage.micros * BigInt(10000)) / totalOnDemand) / 100
        : 0;

      // --- Commitment candidate (sustained on-demand spend on an eligible service) ---
      if (usage.micros >= COMMITMENT_MIN_ONDEMAND_MICROS) {
        const computeEligible = isComputeSavingsPlanEligible(usage.service);
        const reservedEligible = !computeEligible && isReservedCapacityEligible(usage.service);
        if (computeEligible || reservedEligible) {
          const severity: CostOptimizationSeverity = sharePercent >= 40 ? "high" : sharePercent >= 15 ? "medium" : "low";
          const base: Omit<CostOptimization, "estimatedMonthlySavingsMicros" | "evidence"> = {
            id: `commitment-${currency.toLowerCase()}-${slug(usage.service)}`,
            category: "commitment",
            severity,
            currency,
            estimatedMonthlySavings: null, // CUR savings live in the micros field
            title: `${usage.service}: sustained on-demand spend is a commitment candidate (${currency})`,
            summary: computeEligible
              ? "Sustained on-demand compute is a Savings Plan candidate. The estimate applies an assumed, disclosed discount to observed on-demand spend — treat it as a planning input, not a quote."
              : "Sustained on-demand spend is a Reserved Instance / reserved-capacity candidate, but the applicable discount depends on instance family / engine / usage-type that the ingested CUR does not carry — no savings figure is claimed.",
          };
          if (computeEligible) {
            const savings = (usage.micros * BigInt(COMMITMENT_ASSUMED_DISCOUNT_BP)) / BigInt(10000);
            savingsByCurrencyMicros[currency] = (savingsByCurrencyMicros[currency] ?? BigInt(0)) + savings;
            recommendations.push({
              ...base,
              estimatedMonthlySavingsMicros: savings.toString(),
              evidence: {
                service: usage.service,
                currency,
                onDemandSpendMicros: usage.micros.toString(),
                distinctUsageDays: usage.days.size,
                windowDays,
                coveragePercent,
                sharePercent,
                commitmentVehicle: "compute-savings-plan",
                assumedDiscountPercent: COMMITMENT_ASSUMED_DISCOUNT_BP / 100,
                disclosure: COMMITMENT_DISCOUNT_DISCLOSURE,
              },
            });
          } else {
            recommendations.push({
              ...base,
              estimatedMonthlySavingsMicros: null,
              evidence: {
                service: usage.service,
                currency,
                onDemandSpendMicros: usage.micros.toString(),
                distinctUsageDays: usage.days.size,
                windowDays,
                coveragePercent,
                sharePercent,
                commitmentVehicle: "reserved-instance",
                noSavingsReason: REASON_COMMITMENT_GRANULARITY,
              },
            });
          }
        }
      }

      // --- Rightsizing candidate (sustained, flat/low-proportion cost pattern) ---
      // Utilization is NOT collected, so savings is ALWAYS null: a candidate is
      // a prompt to investigate, never a claimed saving.
      if (usage.micros >= RIGHTSIZE_MIN_ONDEMAND_MICROS) {
        const dailyValues = [...usage.daily.values()];
        const minDaily = dailyValues.reduce((min, value) => (value < min ? value : min), dailyValues[0]);
        const maxDaily = dailyValues.reduce((max, value) => (value > max ? value : max), dailyValues[0]);
        const flat = minDaily > BigInt(0) && maxDaily * BigInt(10000) <= minDaily * BigInt(RIGHTSIZE_FLAT_RATIO_BP);
        const lowProportion = sharePercent < 15;
        if (flat || lowProportion) {
          const flatRatio = minDaily > BigInt(0) ? Number((maxDaily * BigInt(100)) / minDaily) / 100 : 0;
          recommendations.push({
            id: `rightsizing-${currency.toLowerCase()}-${slug(usage.service)}`,
            category: "rightsizing",
            severity: flat && coverage >= 0.99 ? "medium" : "low",
            currency,
            estimatedMonthlySavings: null,
            estimatedMonthlySavingsMicros: null, // utilization not collected → never a dollar figure
            title: `${usage.service}: ${flat ? "flat" : "low-proportion"} sustained cost is a rightsizing candidate (${currency})`,
            summary: "A flat, always-on or low-proportion spend pattern can indicate over-provisioning. Per-resource utilization (CloudWatch) is not collected, so this is an investigation prompt — no savings is claimed.",
            evidence: {
              service: usage.service,
              currency,
              onDemandSpendMicros: usage.micros.toString(),
              distinctUsageDays: usage.days.size,
              windowDays,
              coveragePercent,
              sharePercent,
              minDailyMicros: minDaily.toString(),
              maxDailyMicros: maxDaily.toString(),
              flatRatio,
              pattern: flat ? "flat" : "low-proportion",
              noSavingsReason: REASON_RIGHTSIZE_UTILIZATION,
            },
          });
        }
      }
    }
  }

  const savingsOut: Record<string, string> = {};
  for (const [currency, micros] of Object.entries(savingsByCurrencyMicros)) savingsOut[currency] = micros.toString();
  return { recommendations, savingsByCurrencyMicros: savingsOut };
}

export function buildCostOptimizations(input: {
  readonly snapshot: AwsCostSnapshot | null;
  readonly resources: readonly PilotResource[];
  /** Optional ingested CUR/FOCUS lines; enables commitment + rightsizing candidates. */
  readonly curLines?: readonly NormalizedCurLine[];
}): CostOptimizationReport {
  const recommendations: CostOptimization[] = [];
  const resources = input.resources;
  const snapshot = input.snapshot;
  const curLines = input.curLines ?? [];

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

  // 6 & 7. Commitment (RI/Savings Plan) and rightsizing candidates from CUR.
  const commitment = buildCommitmentAndRightsizing(curLines);
  recommendations.push(...commitment.recommendations);

  const rank: Readonly<Record<CostOptimizationSeverity, number>> = { high: 0, medium: 1, low: 2 };
  recommendations.sort((left, right) => rank[left.severity] - rank[right.severity] || left.id.localeCompare(right.id, "en-US"));

  // Legacy scalar remains snapshot-derived and single-currency (whole units);
  // CUR-derived commitment savings are per-currency micros, never folded in.
  const savings = recommendations.map((rec) => rec.estimatedMonthlySavings).filter((value): value is number => value !== null);
  return {
    schema: "sutra.aws-cost-optimization.v1",
    recommendations,
    summary: {
      count: recommendations.length,
      high: recommendations.filter((rec) => rec.severity === "high").length,
      estimatedMonthlySavings: savings.length > 0 ? savings.reduce((sum, value) => sum + value, 0) : null,
      resourcesAnalyzed: resources.length,
      curLinesAnalyzed: curLines.length,
      commitmentSavingsByCurrencyMicros: commitment.savingsByCurrencyMicros,
    },
    limitations: LIMITATIONS,
    disclaimer: DISCLAIMER,
  };
}
