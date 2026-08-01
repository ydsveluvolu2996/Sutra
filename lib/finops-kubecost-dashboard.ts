import type { KubecostAllocationGroup, KubecostAllocationKind, KubecostAllocationSnapshot, KubecostExactDecimal, KubecostMetric } from "./finops-kubecost-allocation.ts";

export interface KubecostDashboardFilters {
  readonly accountId?: string; readonly clusterId?: string; readonly namespace?: string;
  readonly controllerKind?: string; readonly controller?: string; readonly workload?: string;
  readonly allocationKind?: KubecostAllocationKind; readonly currency?: string;
  readonly limit?: number; readonly cursor?: string;
}

interface Rational { n: bigint; d: bigint }
function gcd(a: bigint, b: bigint): bigint { let left = a < BigInt(0) ? -a : a; let right = b < BigInt(0) ? -b : b; while (right !== BigInt(0)) [left, right] = [right, left % right]; return left; }
function rational(value: KubecostExactDecimal): Rational { return { n: BigInt(value.numerator), d: BigInt(value.denominator) }; }
function add(left: Rational, right: Rational): Rational { const n = left.n * right.d + right.n * left.d; const d = left.d * right.d; const factor = gcd(n, d); return { n: n / factor, d: d / factor }; }
function exact(value: Rational): KubecostExactDecimal { return { numerator: value.n.toString(), denominator: value.d.toString() }; }
function sum(values: readonly KubecostExactDecimal[]): KubecostExactDecimal { return exact(values.reduce((total, value) => add(total, rational(value)), { n: BigInt(0), d: BigInt(1) })); }

function aggregate(groups: readonly KubecostAllocationGroup[], key: (group: KubecostAllocationGroup) => string) {
  const values = new Map<string, KubecostAllocationGroup[]>();
  for (const group of groups) { const identity = key(group); const entries = values.get(identity) ?? []; entries.push(group); values.set(identity, entries); }
  return [...values.entries()].map(([identity, entries]) => ({ identity, currency: entries[0]!.currency, totalCost: sum(entries.map((entry) => entry.totalCost)), groupCount: entries.length }))
    .sort((left, right) => { const a = rational(left.totalCost); const b = rational(right.totalCost); const comparison = b.n * a.d - a.n * b.d; return comparison === BigInt(0) ? left.identity.localeCompare(right.identity) : comparison > BigInt(0) ? 1 : -1; });
}

function efficiency(groups: readonly KubecostAllocationGroup[], metric: KubecostMetric) {
  const evidence = groups.flatMap((group) => group.efficiencies.filter((item) => item.metric === metric && item.requestedOrProvisioned !== null && item.used !== null));
  const requested = sum(evidence.map((item) => item.requestedOrProvisioned!));
  const used = sum(evidence.map((item) => item.used!));
  const request = rational(requested); const usage = rational(used);
  const ratio = request.n === BigInt(0) ? null : (() => {
    const numerator = usage.n * request.d; const denominator = usage.d * request.n;
    const factor = gcd(numerator, denominator); return exact({ n: numerator / factor, d: denominator / factor });
  })();
  return { metric, requestedOrProvisioned: requested, used, ratio, contributingGroupCount: evidence.length, state: evidence.length === 0 ? "UNAVAILABLE" as const : evidence.length === groups.length ? "COMPLETE" as const : "PARTIAL" as const };
}

export function buildKubecostDashboard(snapshot: KubecostAllocationSnapshot, filters: KubecostDashboardFilters = {}) {
  const limit = filters.limit ?? 100; const cursor = filters.cursor ?? "";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || (cursor !== "" && !/^v1:(?:0|[1-9]\d{0,7})$/u.test(cursor))) throw new Error("INVALID_KUBECOST_DASHBOARD_QUERY");
  const matches = (value: string | null, expected: string | undefined) => expected === undefined || value === expected;
  const groups = snapshot.groups.filter((group) => matches(group.usageAccountId, filters.accountId) && matches(group.clusterId, filters.clusterId)
    && matches(group.namespace, filters.namespace) && matches(group.controllerKind, filters.controllerKind)
    && matches(group.controller, filters.controller) && matches(group.workload, filters.workload)
    && matches(group.allocationKind, filters.allocationKind) && matches(group.currency, filters.currency));
  const offset = cursor === "" ? 0 : Number(cursor.slice(3)); if (!Number.isSafeInteger(offset) || offset > groups.length) throw new Error("INVALID_KUBECOST_DASHBOARD_QUERY");
  const rows = groups.slice(offset, offset + limit); const nextCursor = offset + rows.length < groups.length ? `v1:${offset + rows.length}` : null;
  const currencies = [...new Set(groups.map((group) => group.currency))].sort();
  return {
    schema: "sutra.finops-kubecost-dashboard.v1" as const, filters, resultCount: groups.length, rows, nextCursor,
    executiveSummary: { totals: currencies.map((currency) => ({ currency, totalCost: sum(groups.filter((group) => group.currency === currency).map((group) => group.totalCost)) })), efficiencies: [efficiency(groups, "CPU"), efficiency(groups, "RAM")] },
    byAccount: currencies.flatMap((currency) => aggregate(groups.filter((group) => group.currency === currency), (group) => group.usageAccountId).map((item) => ({ accountId: item.identity, ...item }))),
    topClusters: currencies.flatMap((currency) => aggregate(groups.filter((group) => group.currency === currency), (group) => group.clusterId).map((item) => ({ clusterId: item.identity, ...item }))).slice(0, 25),
    pivots: {
      namespaces: currencies.flatMap((currency) => aggregate(groups.filter((group) => group.currency === currency), (group) => group.namespace ?? "UNALLOCATED")),
      controllers: currencies.flatMap((currency) => aggregate(groups.filter((group) => group.currency === currency), (group) => `${group.controllerKind ?? "NONE"}/${group.controller ?? "UNALLOCATED"}`)),
      workloads: currencies.flatMap((currency) => aggregate(groups.filter((group) => group.currency === currency), (group) => group.workload ?? "UNALLOCATED")),
    },
    reconciliation: snapshot.reconciliation, coverage: snapshot.coverage, source: snapshot.exportLineage,
    unsupported: {
      cpuRamCostSplit: "Normalized groups retain exact total cost and efficiency, but not CPU/RAM component cost; no split is inferred.",
      timeSeries: "The accepted snapshot aggregates its explicit window; per-hour trend facts are not retained in this projection.",
      eksCapacityInstanceType: "The Kubecost allocation contract does not carry EKS node capacity type or EC2 instance type dimensions.",
    },
  };
}
