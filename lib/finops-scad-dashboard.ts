import type {
  ScadAllocationGroup,
  ScadAllocationSnapshot,
  ScadExactDecimal,
  ScadMetric,
  ScadPlatform,
} from "./finops-scad-allocation.ts";

export interface ScadAcceptedHead {
  readonly generationId: string;
  readonly contentSha256: string;
  readonly snapshot: ScadAllocationSnapshot;
}
export interface ScadDashboardFilters {
  readonly accountId: string | null;
  readonly region: string | null;
  readonly platform: ScadPlatform | null;
  readonly cluster: string | null;
  readonly namespace: string | null;
  readonly workload: string | null;
  readonly metric: ScadMetric | null;
  readonly tagKey: string | null;
  readonly tagValue: string | null;
  readonly search: string | null;
  readonly showbackBy: "ACCOUNT" | "CLUSTER" | "NAMESPACE" | "WORKLOAD" | "TAG";
}
export interface ScadAmount {
  readonly currency: string;
  readonly exact: ScadExactDecimal;
}
export const SCAD_DASHBOARD_BOUNDS = Object.freeze({
  detailRows: 1_000,
  aggregateRows: 250,
  filterOptions: 250,
});
export interface ScadDashboardProjection {
  readonly schemaVersion: "sutra.scad-allocation-dashboard.v1";
  readonly generatedAtIso: string;
  readonly filters: ScadDashboardFilters;
  readonly executive: {
    readonly billingPeriodCount: number;
    readonly rowCount: number;
    readonly groupCount: number;
    readonly accountCount: number;
    readonly clusterCount: number;
    readonly allocated: readonly ScadAmount[];
    readonly attributedUnused: readonly ScadAmount[];
    readonly total: readonly ScadAmount[];
    readonly missingBusinessLineage: readonly ScadAmount[];
  };
  readonly metricKpis: readonly {
    readonly category: "CPU" | "RAM" | "GPU_ACCELERATOR";
    readonly groupCount: number;
    readonly allocated: readonly ScadAmount[];
    readonly attributedUnused: readonly ScadAmount[];
    readonly total: readonly ScadAmount[];
  }[];
  readonly accountSummary: readonly AllocationDimension[];
  readonly clusterSummary: readonly AllocationDimension[];
  readonly workloads: readonly WorkloadRow[];
  readonly clusterCoverage: readonly {
    readonly cluster: string;
    readonly platform: ScadPlatform;
    readonly accountId: string;
    readonly region: string;
    readonly namespaceCount: number;
    readonly workloadCount: number;
    readonly podOrTaskCount: number;
    readonly missingLineageGroups: number;
    readonly costs: readonly ScadAmount[];
  }[];
  readonly tags: readonly {
    readonly key: string;
    readonly value: string;
    readonly groupCount: number;
    readonly costs: readonly ScadAmount[];
  }[];
  readonly tco: {
    readonly basis: "SCAD_TAGGED_POD_TASK_COST_ONLY";
    readonly groups: readonly {
      readonly key: string;
      readonly value: string;
      readonly costs: readonly ScadAmount[];
    }[];
    readonly limitation: string;
  };
  readonly dataFrameworks: readonly {
    readonly framework: "SPARK" | "FLINK" | "EMR_ON_EKS";
    readonly evidenceBasis: "SUTRA_NAME_OR_TAG_INFERENCE";
    readonly groupCount: number;
    readonly costs: readonly ScadAmount[];
  }[];
  readonly showback: {
    readonly allocationBasis: ScadDashboardFilters["showbackBy"];
    readonly chargebackPolicy: "CUR2_ATTRIBUTED_AMORTIZED_COST";
    readonly rows: readonly AllocationDimension[];
  };
  readonly reconciliation: readonly {
    readonly billingPeriodStartAt: string;
    readonly generationId: string;
    readonly currency: string;
    readonly sourceTotal: ScadExactDecimal;
    readonly projectedGroupTotal: ScadExactDecimal;
    readonly difference: ScadExactDecimal;
    readonly reconciled: boolean;
  }[];
  readonly periods: readonly {
    readonly generationId: string;
    readonly contentSha256: string;
    readonly captureId: string;
    readonly activeGenerationId: string;
    readonly billingPeriodStartAt: string;
    readonly billingPeriodEndAt: string;
    readonly dataThroughAt: string;
    readonly state: ScadAllocationSnapshot["state"];
    readonly deliveryState: ScadAllocationSnapshot["deliveryState"];
    readonly complete: boolean;
    readonly objectCoverage: ScadAllocationSnapshot["objectCoverage"];
    readonly historicalCoverage: ScadAllocationSnapshot["historicalCoverage"];
  }[];
  readonly filterOptions: {
    readonly accounts: readonly string[];
    readonly regions: readonly string[];
    readonly platforms: readonly ScadPlatform[];
    readonly clusters: readonly string[];
    readonly namespaces: readonly string[];
    readonly workloads: readonly string[];
    readonly metrics: readonly ScadMetric[];
    readonly tagKeys: readonly string[];
    readonly tagValues: readonly string[];
  };
  readonly projectionTruncation: {
    readonly workloads: boolean;
    readonly accountSummary: boolean;
    readonly clusterSummary: boolean;
    readonly clusterCoverage: boolean;
    readonly tags: boolean;
    readonly showback: boolean;
    readonly filterOptions: boolean;
  };
  readonly limitations: readonly string[];
}
export interface AllocationDimension {
  readonly key: string;
  readonly groupCount: number;
  readonly podOrTaskCount: number;
  readonly costs: readonly ScadAmount[];
}
export interface WorkloadRow {
  readonly accountId: string;
  readonly region: string;
  readonly platform: ScadPlatform;
  readonly cluster: string | null;
  readonly namespace: string | null;
  readonly workloadType: string | null;
  readonly workload: string | null;
  readonly podOrTaskId: string;
  readonly metric: ScadMetric;
  readonly requestedUsage: ScadAllocationGroup["requestedUsage"];
  readonly actualUsage: ScadAllocationGroup["actualUsage"];
  readonly allocatedUsage: ScadExactDecimal;
  readonly costs: readonly ScadAmount[];
  readonly businessTags: ScadAllocationGroup["lineage"]["businessTags"];
}

interface Rational {
  n: bigint;
  d: bigint;
}
function gcd(a: bigint, b: bigint): bigint {
  let left = a < 0 ? -a : a;
  let right = b < 0 ? -b : b;
  while (right !== BigInt(0)) {
    const rest = left % right;
    left = right;
    right = rest;
  }
  return left === BigInt(0) ? BigInt(1) : left;
}
function normalize(n: bigint, d: bigint): Rational {
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}
function add(left: Rational, right: Rational): Rational {
  return normalize(left.n * right.d + right.n * left.d, left.d * right.d);
}
function subtract(left: Rational, right: Rational): Rational {
  return normalize(left.n * right.d - right.n * left.d, left.d * right.d);
}
function rational(value: ScadExactDecimal): Rational {
  const n = BigInt(value.numerator);
  const d = BigInt(value.denominator);
  if (d <= BigInt(0)) throw new Error("scad-dashboard-invalid");
  return normalize(n, d);
}
function exact(value: Rational): ScadExactDecimal {
  return { numerator: value.n.toString(), denominator: value.d.toString() };
}
function compareDimensions(
  left: AllocationDimension,
  right: AllocationDimension,
): number {
  if (
    left.costs.length === 1 &&
    right.costs.length === 1 &&
    left.costs[0]?.currency === right.costs[0]?.currency
  ) {
    const leftValue = rational(left.costs[0].exact);
    const rightValue = rational(right.costs[0].exact);
    const comparison = leftValue.n * rightValue.d - rightValue.n * leftValue.d;
    if (comparison !== BigInt(0)) return comparison > BigInt(0) ? -1 : 1;
  }
  return left.key.localeCompare(right.key);
}
function addAmount(
  map: Map<string, Rational>,
  currency: string,
  value: ScadExactDecimal,
): void {
  map.set(
    currency,
    add(map.get(currency) ?? { n: BigInt(0), d: BigInt(1) }, rational(value)),
  );
}
function amounts(map: ReadonlyMap<string, Rational>): readonly ScadAmount[] {
  return [...map.entries()]
    .map(([currency, value]) => ({ currency, exact: exact(value) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
function groupAmounts(
  groups: readonly ScadAllocationGroup[],
): readonly ScadAmount[] {
  const map = new Map<string, Rational>();
  for (const group of groups)
    addAmount(map, group.currency, group.attributedAmortizedCost);
  return amounts(map);
}
function dimensions(
  groups: readonly ScadAllocationGroup[],
  keyFor: (group: ScadAllocationGroup) => string,
): readonly AllocationDimension[] {
  const byKey = new Map<string, ScadAllocationGroup[]>();
  for (const group of groups) {
    const key = keyFor(group);
    byKey.set(key, [...(byKey.get(key) ?? []), group]);
  }
  return [...byKey.entries()]
    .map(([key, items]) => ({
      key,
      groupCount: items.length,
      podOrTaskCount: new Set(items.map((item) => item.lineage.podOrTaskId))
        .size,
      costs: groupAmounts(items),
    }))
    .sort(compareDimensions);
}
function text(group: ScadAllocationGroup): string {
  return [
    group.lineage.cluster,
    group.lineage.namespace,
    group.lineage.workloadType,
    group.lineage.workload,
    group.lineage.deployment,
    group.lineage.podOrTaskId,
    ...group.lineage.businessTags.flatMap((tag) => [tag.key, tag.value]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}
function metricCategory(metric: ScadMetric): "CPU" | "RAM" | "GPU_ACCELERATOR" {
  return metric === "VCPU"
    ? "CPU"
    : metric === "MEMORY"
      ? "RAM"
      : "GPU_ACCELERATOR";
}
function framework(
  group: ScadAllocationGroup,
): "SPARK" | "FLINK" | "EMR_ON_EKS" | null {
  const value = text(group);
  if (/emr.{0,8}(eks|containers)|emr_on_eks/u.test(value)) return "EMR_ON_EKS";
  if (/spark/u.test(value)) return "SPARK";
  if (/flink/u.test(value)) return "FLINK";
  return null;
}

function bounded<T>(values: readonly T[], maximum: number) {
  return {
    values: values.slice(0, maximum),
    truncated: values.length > maximum,
  };
}

export function buildScadDashboard(
  heads: readonly ScadAcceptedHead[],
  filters: ScadDashboardFilters,
  nowMs = Date.now(),
): ScadDashboardProjection {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || heads.length > 120)
    throw new Error("scad-dashboard-invalid");
  const allGroups = heads.flatMap((head) => head.snapshot.groups);
  const search = filters.search?.toLocaleLowerCase() ?? null;
  const groups = allGroups.filter(
    (group) =>
      (filters.accountId === null ||
        group.lineage.usageAccountId === filters.accountId) &&
      (filters.region === null || group.lineage.region === filters.region) &&
      (filters.platform === null ||
        group.lineage.platform === filters.platform) &&
      (filters.cluster === null || group.lineage.cluster === filters.cluster) &&
      (filters.namespace === null ||
        group.lineage.namespace === filters.namespace) &&
      (filters.workload === null ||
        group.lineage.workload === filters.workload) &&
      (filters.metric === null || group.metric === filters.metric) &&
      (filters.tagKey === null ||
        group.lineage.businessTags.some(
          (tag) =>
            tag.key === filters.tagKey &&
            (filters.tagValue === null || tag.value === filters.tagValue),
        )) &&
      (search === null || text(group).includes(search)),
  );
  const allocated = new Map<string, Rational>();
  const unused = new Map<string, Rational>();
  const total = new Map<string, Rational>();
  for (const group of groups) {
    addAmount(allocated, group.currency, group.allocatedAmortizedCost);
    addAmount(unused, group.currency, group.attributedUnusedAmortizedCost);
    addAmount(total, group.currency, group.attributedAmortizedCost);
  }
  const missing = new Map<string, Rational>();
  for (const head of heads)
    for (const item of head.snapshot.lineageCoverage.unallocatedAmortizedCost)
      addAmount(missing, item.currency, item.exact);
  const metricKpis = (["CPU", "RAM", "GPU_ACCELERATOR"] as const).map(
    (category) => {
      const selected = groups.filter(
        (group) => metricCategory(group.metric) === category,
      );
      const a = new Map<string, Rational>();
      const u = new Map<string, Rational>();
      const t = new Map<string, Rational>();
      for (const group of selected) {
        addAmount(a, group.currency, group.allocatedAmortizedCost);
        addAmount(u, group.currency, group.attributedUnusedAmortizedCost);
        addAmount(t, group.currency, group.attributedAmortizedCost);
      }
      return {
        category,
        groupCount: selected.length,
        allocated: amounts(a),
        attributedUnused: amounts(u),
        total: amounts(t),
      };
    },
  );
  const clusterMap = new Map<string, ScadAllocationGroup[]>();
  for (const group of groups) {
    const key = JSON.stringify([
      group.lineage.cluster ?? "Unallocated",
      group.lineage.platform,
      group.lineage.usageAccountId,
      group.lineage.region,
    ]);
    clusterMap.set(key, [...(clusterMap.get(key) ?? []), group]);
  }
  const clusterCoverage = [...clusterMap.entries()]
    .map(([key, items]) => {
      const [cluster, platform, accountId, region] = JSON.parse(key) as [
        string,
        ScadPlatform,
        string,
        string,
      ];
      return {
        cluster,
        platform,
        accountId,
        region,
        namespaceCount: new Set(
          items.map((item) => item.lineage.namespace).filter(Boolean),
        ).size,
        workloadCount: new Set(
          items.map((item) => item.lineage.workload).filter(Boolean),
        ).size,
        podOrTaskCount: new Set(items.map((item) => item.lineage.podOrTaskId))
          .size,
        missingLineageGroups: items.filter(
          (item) => !item.lineage.completeThroughPodOrTask,
        ).length,
        costs: groupAmounts(items),
      };
    })
    .sort(
      (a, b) =>
        a.cluster.localeCompare(b.cluster) ||
        a.accountId.localeCompare(b.accountId),
    );
  const tagMap = new Map<string, ScadAllocationGroup[]>();
  for (const group of groups)
    for (const tag of group.lineage.businessTags) {
      const key = JSON.stringify([tag.key, tag.value]);
      tagMap.set(key, [...(tagMap.get(key) ?? []), group]);
    }
  const tags = [...tagMap.entries()]
    .map(([key, items]) => {
      const [tagKey, value] = JSON.parse(key) as [string, string];
      return {
        key: tagKey,
        value,
        groupCount: items.length,
        costs: groupAmounts(items),
      };
    })
    .sort(
      (a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value),
    );
  const frameworks = (["SPARK", "FLINK", "EMR_ON_EKS"] as const).map((name) => {
    const items = groups.filter((group) => framework(group) === name);
    return {
      framework: name,
      evidenceBasis: "SUTRA_NAME_OR_TAG_INFERENCE" as const,
      groupCount: items.length,
      costs: groupAmounts(items),
    };
  });
  const showbackKey = (group: ScadAllocationGroup): string =>
    filters.showbackBy === "ACCOUNT"
      ? group.lineage.usageAccountId
      : filters.showbackBy === "CLUSTER"
        ? (group.lineage.cluster ?? "Unallocated")
        : filters.showbackBy === "NAMESPACE"
          ? (group.lineage.namespace ?? "Unallocated")
          : filters.showbackBy === "WORKLOAD"
            ? (group.lineage.workload ?? "Unallocated")
            : filters.tagKey === null
              ? "Tag key required"
              : (group.lineage.businessTags.find(
                  (tag) => tag.key === filters.tagKey,
                )?.value ?? "Untagged");
  const reconciliation = heads.flatMap((head) =>
    head.snapshot.totals.attributedAmortizedCost.map((source) => {
      const projected = new Map<string, Rational>();
      for (const group of head.snapshot.groups)
        addAmount(projected, group.currency, group.attributedAmortizedCost);
      const value = projected.get(source.currency) ?? {
        n: BigInt(0),
        d: BigInt(1),
      };
      const difference = subtract(rational(source.exact), value);
      return {
        billingPeriodStartAt: head.snapshot.billingPeriodStartAt,
        generationId: head.generationId,
        currency: source.currency,
        sourceTotal: source.exact,
        projectedGroupTotal: exact(value),
        difference: exact(difference),
        reconciled: difference.n === BigInt(0),
      };
    }),
  );
  const accountRows = bounded(
    dimensions(groups, (group) => group.lineage.usageAccountId),
    SCAD_DASHBOARD_BOUNDS.aggregateRows,
  );
  const clusterRows = bounded(
    dimensions(groups, (group) => group.lineage.cluster ?? "Unallocated"),
    SCAD_DASHBOARD_BOUNDS.aggregateRows,
  );
  const workloadRows = bounded(
    groups.map((group) => ({
      accountId: group.lineage.usageAccountId,
      region: group.lineage.region,
      platform: group.lineage.platform,
      cluster: group.lineage.cluster,
      namespace: group.lineage.namespace,
      workloadType: group.lineage.workloadType,
      workload: group.lineage.workload,
      podOrTaskId: group.lineage.podOrTaskId,
      metric: group.metric,
      requestedUsage: group.requestedUsage,
      actualUsage: group.actualUsage,
      allocatedUsage: group.allocatedUsage,
      costs: [
        { currency: group.currency, exact: group.attributedAmortizedCost },
      ],
      businessTags: group.lineage.businessTags,
    })),
    SCAD_DASHBOARD_BOUNDS.detailRows,
  );
  const clusterCoverageRows = bounded(
    clusterCoverage,
    SCAD_DASHBOARD_BOUNDS.aggregateRows,
  );
  const tagRows = bounded(tags, SCAD_DASHBOARD_BOUNDS.aggregateRows);
  const showbackRows = bounded(
    dimensions(groups, showbackKey),
    SCAD_DASHBOARD_BOUNDS.aggregateRows,
  );
  const accounts = bounded(
    [...new Set(allGroups.map((group) => group.lineage.usageAccountId))].sort(),
    SCAD_DASHBOARD_BOUNDS.filterOptions,
  );
  const regions = bounded(
    [...new Set(allGroups.map((group) => group.lineage.region))].sort(),
    SCAD_DASHBOARD_BOUNDS.filterOptions,
  );
  const platforms = bounded(
    [...new Set(allGroups.map((group) => group.lineage.platform))].sort(),
    SCAD_DASHBOARD_BOUNDS.filterOptions,
  );
  const clusters = bounded(
    [
      ...new Set(
        allGroups
          .map((group) => group.lineage.cluster)
          .filter((item): item is string => item !== null),
      ),
    ].sort(),
    SCAD_DASHBOARD_BOUNDS.filterOptions,
  );
  const namespaces = bounded(
    [
      ...new Set(
        allGroups
          .map((group) => group.lineage.namespace)
          .filter((item): item is string => item !== null),
      ),
    ].sort(),
    SCAD_DASHBOARD_BOUNDS.filterOptions,
  );
  const workloads = bounded(
    [
      ...new Set(
        allGroups
          .map((group) => group.lineage.workload)
          .filter((item): item is string => item !== null),
      ),
    ].sort(),
    SCAD_DASHBOARD_BOUNDS.filterOptions,
  );
  const metrics = bounded(
    [...new Set(allGroups.map((group) => group.metric))].sort(),
    SCAD_DASHBOARD_BOUNDS.filterOptions,
  );
  const tagKeys = bounded(
    [
      ...new Set(
        allGroups.flatMap((group) =>
          group.lineage.businessTags.map((tag) => tag.key),
        ),
      ),
    ].sort(),
    SCAD_DASHBOARD_BOUNDS.filterOptions,
  );
  const tagValues = bounded(
    [
      ...new Set(
        allGroups.flatMap((group) =>
          group.lineage.businessTags
            .filter(
              (tag) => filters.tagKey === null || tag.key === filters.tagKey,
            )
            .map((tag) => tag.value),
        ),
      ),
    ].sort(),
    SCAD_DASHBOARD_BOUNDS.filterOptions,
  );
  return {
    schemaVersion: "sutra.scad-allocation-dashboard.v1",
    generatedAtIso: new Date(nowMs).toISOString(),
    filters,
    executive: {
      billingPeriodCount: heads.length,
      rowCount: heads.reduce((sum, head) => sum + head.snapshot.rowCount, 0),
      groupCount: groups.length,
      accountCount: new Set(groups.map((group) => group.lineage.usageAccountId))
        .size,
      clusterCount: new Set(
        groups.map((group) => group.lineage.cluster).filter(Boolean),
      ).size,
      allocated: amounts(allocated),
      attributedUnused: amounts(unused),
      total: amounts(total),
      missingBusinessLineage: amounts(missing),
    },
    metricKpis,
    accountSummary: accountRows.values,
    clusterSummary: clusterRows.values,
    workloads: workloadRows.values,
    clusterCoverage: clusterCoverageRows.values,
    tags: tagRows.values,
    tco: {
      basis: "SCAD_TAGGED_POD_TASK_COST_ONLY",
      groups: tagRows.values.map((tag) => ({
        key: tag.key,
        value: tag.value,
        costs: tag.costs,
      })),
      limitation:
        "TCO includes only tagged SCAD pod/task rows. Tagged EC2, EBS, load balancer and other AWS resource costs require a separate governed CUR2 resource join.",
    },
    dataFrameworks: frameworks,
    showback: {
      allocationBasis: filters.showbackBy,
      chargebackPolicy: "CUR2_ATTRIBUTED_AMORTIZED_COST",
      rows: showbackRows.values,
    },
    reconciliation,
    periods: heads
      .map((head) => ({
        generationId: head.generationId,
        contentSha256: head.contentSha256,
        captureId: head.snapshot.captureId,
        activeGenerationId: head.snapshot.activeGenerationId,
        billingPeriodStartAt: head.snapshot.billingPeriodStartAt,
        billingPeriodEndAt: head.snapshot.billingPeriodEndAt,
        dataThroughAt: head.snapshot.dataThroughAt,
        state: head.snapshot.state,
        deliveryState: head.snapshot.deliveryState,
        complete: head.snapshot.complete,
        objectCoverage: head.snapshot.objectCoverage,
        historicalCoverage: head.snapshot.historicalCoverage,
      }))
      .sort((a, b) =>
        a.billingPeriodStartAt.localeCompare(b.billingPeriodStartAt),
      ),
    filterOptions: {
      accounts: accounts.values,
      regions: regions.values,
      platforms: platforms.values,
      clusters: clusters.values,
      namespaces: namespaces.values,
      workloads: workloads.values,
      metrics: metrics.values,
      tagKeys: tagKeys.values,
      tagValues: tagValues.values,
    },
    projectionTruncation: {
      workloads: workloadRows.truncated,
      accountSummary: accountRows.truncated,
      clusterSummary: clusterRows.truncated,
      clusterCoverage: clusterCoverageRows.truncated,
      tags: tagRows.truncated,
      showback: showbackRows.truncated,
      filterOptions:
        accounts.truncated ||
        regions.truncated ||
        platforms.truncated ||
        clusters.truncated ||
        namespaces.truncated ||
        workloads.truncated ||
        metrics.truncated ||
        tagKeys.truncated ||
        tagValues.truncated,
    },
    limitations: [
      "SCAD publishes pod/task allocation, not container identifiers.",
      "Attributed unused cost is AWS SCAD idle-capacity allocation; it is not a complete shared-platform overhead model.",
      "Actual usage remains unavailable when SCAD is configured for resource requests only.",
      "Spark, Flink and EMR-on-EKS classifications are labeled Sutra name/tag inference.",
      "SCAD has no historical backfill before enablement; corrected billing generations replace a period atomically.",
    ],
  };
}
