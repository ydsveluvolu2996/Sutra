/**
 * PURE demo-seed fixtures — the realistic-but-clearly-demo sample data that the
 * local/fixture pilot's seed script (scripts/seed-demo-data.mjs) writes through
 * the honest repositories so every panel renders before a tester has connected
 * their own AWS.
 *
 * This module is PURE: it constructs plain data only — no I/O, no clock, no
 * database, no engine imports. It NEVER fabricates data in a live tenant; it is
 * only ever imported by the guarded local-mode seed script. Every value is
 * deterministic so re-running the seed replaces (never duplicates) and the
 * numbers stay stable across runs. Amounts are integer micro-units to match the
 * CUR/FOCUS money model (lib/finops-cur.ts) exactly.
 *
 * The demo tenant reuses the bundled "northstar-retail" simulated-fixture
 * identity (services/aws-collector/src/local-fixture-catalog.ts) so the seeded
 * data lines up with the fixture connection the local pilot already knows about.
 */
import type { NormalizedCurLine } from "./finops-cur.ts";

/** The one demo customer everything is seeded under (northstar-retail fixture). */
export const DEMO_ORG_ID = "org_local_sutra";
export const DEMO_CUSTOMER_ID = "cust_11111111111111111111111111111111";
export const DEMO_CONNECTION_ID = "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const DEMO_FIXTURE_ID = "northstar-retail";
export const DEMO_CUSTOMER_NAME = "Northstar Retail";
export const DEMO_ACCOUNT_ID = "111122223333";
export const DEMO_PARTITION = "aws";
export const DEMO_REGIONS: readonly string[] = ["us-east-1", "us-west-2"];
/** Author recorded on every seeded row; clearly identifies the origin as demo. */
export const DEMO_CREATED_BY = "demo-seed";

/** The three consecutive billing periods seeded (UTC calendar months). */
export const DEMO_PERIODS: readonly string[] = ["2026-05", "2026-06", "2026-07"];

/** The latest period's day that carries a deliberate cost spike (anomaly demo). */
const ANOMALY_PERIOD = "2026-07";
const ANOMALY_DAY = 14;

const USD = "USD";
const MICROS_PER_UNIT = 1_000_000;

function dollarsToMicros(dollars: number): string {
  return Math.round(dollars * MICROS_PER_UNIT).toString();
}

function daysInMonth(period: string): number {
  const [year, month] = period.split("-").map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayIso(period: string, day: number): string {
  return `${period}-${day.toString().padStart(2, "0")}T00:00:00.000Z`;
}

/**
 * A per-service daily on-demand cost profile. `tags` are attached to every line
 * for that service so allocation / showback / tag-governance all have something
 * honest to group by. An empty tag object models UNTAGGED spend (surfaced by the
 * tag-governance panel), never hidden.
 */
interface ServiceProfile {
  readonly service: string;
  readonly dailyUsd: number;
  readonly tags: Readonly<Record<string, string>>;
}

const SERVICE_PROFILES: readonly ServiceProfile[] = [
  { service: "AmazonEC2", dailyUsd: 118, tags: { env: "prod", team: "storefront", app: "web" } },
  { service: "AmazonRDS", dailyUsd: 64, tags: { env: "prod", team: "payments", app: "orders" } },
  { service: "AmazonS3", dailyUsd: 17, tags: { env: "prod", team: "data", app: "lake" } },
  { service: "AWSLambda", dailyUsd: 9, tags: { env: "staging", team: "platform", app: "api" } },
  { service: "AmazonCloudWatch", dailyUsd: 6, tags: { env: "prod", team: "platform", app: "observability" } },
  { service: "AmazonEKS", dailyUsd: 24, tags: { env: "prod", team: "platform", app: "cluster" } },
  // Deliberately UNTAGGED spend so the tag-governance panel has a real gap to show.
  { service: "AmazonSNS", dailyUsd: 4, tags: {} },
];

// Commitment-covered usage (Savings Plan) so realized-savings + commitment
// coverage render. On-demand-equivalent is NOT persisted by the CUR line model,
// so the savings engine will honestly report the period saving as
// not-derivable from unblended-only data rather than inventing a discount.
const COVERED_PROFILES: readonly { service: string; dailyUsd: number; tags: Record<string, string> }[] = [
  { service: "AmazonEC2", dailyUsd: 40, tags: { env: "prod", team: "storefront", app: "web" } },
  { service: "AmazonRDS", dailyUsd: 22, tags: { env: "prod", team: "payments", app: "orders" } },
];
// Monthly recurring Savings Plan commitment fee.
const MONTHLY_COMMITMENT_FEE_USD = 1_480;

function jitter(base: number, day: number): number {
  // Deterministic gentle day-of-week style variation so trends are not flat.
  return base * (0.9 + ((day % 7) * 0.031));
}

/**
 * Build the seeded CUR lines grouped by billing period. Each period gets one
 * on-demand "Usage" line per service per day, daily commitment-covered lines for
 * EC2/RDS, and a monthly commitment fee. The latest period carries one clearly
 * larger EC2 spike day so the cost-anomaly panel has a real anomaly to surface.
 */
export function buildDemoCurPeriods(): readonly { period: string; lines: readonly NormalizedCurLine[] }[] {
  return DEMO_PERIODS.map((period) => {
    const lines: NormalizedCurLine[] = [];
    const dayCount = daysInMonth(period);
    for (let day = 1; day <= dayCount; day += 1) {
      const usageStartIso = dayIso(period, day);
      for (const profile of SERVICE_PROFILES) {
        lines.push({
          lineItemId: `${profile.service}-${period}-${day.toString().padStart(2, "0")}-usage`,
          usageAccountId: DEMO_ACCOUNT_ID,
          service: profile.service,
          chargeCategory: "Usage",
          usageStartIso,
          amountMicros: dollarsToMicros(jitter(profile.dailyUsd, day)),
          currency: USD,
          region: null,
          tags: profile.tags,
        });
      }
      for (const covered of COVERED_PROFILES) {
        lines.push({
          lineItemId: `${covered.service}-${period}-${day.toString().padStart(2, "0")}-covered`,
          usageAccountId: DEMO_ACCOUNT_ID,
          service: covered.service,
          chargeCategory: "SavingsPlanCoveredUsage",
          usageStartIso,
          amountMicros: dollarsToMicros(jitter(covered.dailyUsd, day)),
          currency: USD,
          region: null,
          tags: covered.tags,
        });
      }
    }
    // Monthly recurring commitment fee, dated the first of the month.
    lines.push({
      lineItemId: `SavingsPlan-${period}-fee`,
      usageAccountId: DEMO_ACCOUNT_ID,
      service: "AWSSavingsPlan",
      chargeCategory: "SavingsPlanRecurringFee",
      usageStartIso: dayIso(period, 1),
      amountMicros: dollarsToMicros(MONTHLY_COMMITMENT_FEE_USD),
      currency: USD,
      region: null,
      tags: { commitment: "compute-sp-1yr" },
    });
    // One deliberate anomaly day in the latest period.
    if (period === ANOMALY_PERIOD) {
      lines.push({
        lineItemId: `AmazonEC2-${period}-${ANOMALY_DAY}-spike`,
        usageAccountId: DEMO_ACCOUNT_ID,
        service: "AmazonEC2",
        chargeCategory: "Usage",
        usageStartIso: dayIso(period, ANOMALY_DAY),
        amountMicros: dollarsToMicros(890),
        currency: USD,
        region: null,
        tags: { env: "prod", team: "storefront", app: "web", incident: "load-test" },
      });
    }
    return { period, lines };
  });
}

export interface DemoBudget {
  readonly name: string;
  readonly currency: string;
  readonly limitMicros: string;
  readonly filter?: { readonly dimension: "account" | "service" | "tag"; readonly tagKey?: string; readonly value: string };
}

/** Two budgets: a whole-tenant monthly cap and a per-service EC2 cap. */
export function buildDemoBudgets(): readonly DemoBudget[] {
  return [
    { name: "Monthly cloud spend", currency: USD, limitMicros: dollarsToMicros(6_500) },
    {
      name: "EC2 monthly budget",
      currency: USD,
      limitMicros: dollarsToMicros(4_000),
      filter: { dimension: "service", value: "AmazonEC2" },
    },
  ];
}

export interface DemoUnitCount {
  readonly period: string;
  readonly unitLabel: string;
  readonly count: number;
}

/** Business denominators for unit-economics (spend per transaction / per seat). */
export function buildDemoUnitCounts(): readonly DemoUnitCount[] {
  const transactions: Record<string, number> = { "2026-05": 4_200_000, "2026-06": 4_760_000, "2026-07": 5_120_000 };
  const seats: Record<string, number> = { "2026-05": 1_180, "2026-06": 1_255, "2026-07": 1_340 };
  const counts: DemoUnitCount[] = [];
  for (const period of DEMO_PERIODS) {
    counts.push({ period, unitLabel: "transactions", count: transactions[period] });
    counts.push({ period, unitLabel: "active-seats", count: seats[period] });
  }
  return counts;
}

export interface DemoSavedReport {
  readonly name: string;
  readonly definition: unknown;
}

/** A saved report-builder view over the CMDB resources dataset. */
export function buildDemoSavedReport(): DemoSavedReport {
  return {
    name: "EC2 inventory snapshot",
    definition: {
      dataset: "cmdb-resources",
      filters: { combine: "and", predicates: [{ kind: "field", field: "service", op: "eq", value: "ec2" }] },
      columns: ["regionKey", "resourceKey", "service", "state"],
      sort: { field: "resourceKey", direction: "asc" },
      limit: 100,
    },
  };
}

export interface DemoAlertRule {
  readonly name: string;
  readonly metric: string;
  readonly comparator: string;
  readonly threshold: number;
  readonly severity: string;
  readonly enabled: boolean;
}

/** Two metric-alerting rules covering cost anomalies and budget breaches. */
export function buildDemoAlertRules(): readonly DemoAlertRule[] {
  return [
    { name: "Cost anomaly detected", metric: "cost-anomaly-count", comparator: "gt", threshold: 0, severity: "medium", enabled: true },
    { name: "Budget breach", metric: "budget-breach-count", comparator: "gte", threshold: 1, severity: "high", enabled: true },
  ];
}

export interface DemoCustomAsset {
  readonly assetType: string;
  readonly name: string;
  readonly source: "manual";
  readonly externalId: string | null;
  readonly fields: Readonly<Record<string, string>>;
}

/** SaaS app, network device, and on-prem server — the three external types. */
export function buildDemoCustomAssets(): readonly DemoCustomAsset[] {
  return [
    {
      assetType: "saas-app",
      name: "Datadog (observability)",
      source: "manual",
      externalId: "saas-datadog-001",
      fields: { vendor: "Datadog", owner: "platform", "data-classification": "internal", url: "https://app.datadoghq.com" },
    },
    {
      assetType: "network-device",
      name: "edge-firewall-01",
      source: "manual",
      externalId: "net-fw-01",
      fields: { vendor: "Palo Alto", model: "PA-440", site: "us-east-colo", mgmt_ip: "10.0.0.1" },
    },
    {
      assetType: "on-prem-server",
      name: "colo-db-primary",
      source: "manual",
      externalId: "onprem-db-01",
      fields: { role: "postgres-primary", site: "us-east-colo", cpu: "32", memory_gb: "256" },
    },
  ];
}

export interface DemoRelationship {
  readonly fromKey: string;
  readonly toKey: string;
  readonly relType: string;
  readonly note: string;
}

/** One manual (user-asserted) CMDB edge between two demo cloud resources. */
export function buildDemoRelationship(): DemoRelationship {
  return {
    fromKey: `aws:${DEMO_ACCOUNT_ID}:us-east-1:ec2:aws.ec2.instance:i-0demostorefront1`,
    toKey: `aws:${DEMO_ACCOUNT_ID}:us-east-1:rds:aws.rds.instance:orders-primary`,
    relType: "connects-to",
    note: "Storefront web tier reaches the orders database (demo-asserted).",
  };
}

const K8S_NAMESPACE_PAYMENTS = "payments";
const K8S_NAMESPACE_STOREFRONT = "storefront";

function workload(
  namespace: string,
  name: string,
  cpuMillicores: number,
  memoryBytes: number,
  imageChar: string,
): unknown {
  return {
    kind: "Workload",
    workloadKind: "Deployment",
    namespace,
    name,
    serviceAccountName: name,
    hostNetwork: false,
    hostPid: false,
    hostIpc: false,
    hasHostPath: false,
    runAsNonRoot: true,
    seccompProfile: "RuntimeDefault",
    containers: [
      {
        name,
        image: `registry.example/${name}@sha256:${imageChar.repeat(64)}`,
        privileged: false,
        allowPrivilegeEscalation: false,
        runAsNonRoot: true,
        capabilitiesAdd: [],
        capabilitiesDrop: ["ALL"],
        hasCpuRequest: true,
        hasMemoryRequest: true,
        hasCpuLimit: true,
        hasMemoryLimit: true,
        hasLivenessProbe: true,
        hasReadinessProbe: true,
        cpuRequestMillicores: cpuMillicores,
        memoryRequestBytes: memoryBytes,
      },
    ],
  };
}

export interface DemoKubernetesScan {
  readonly clusterUid: string;
  readonly clusterName: string;
  readonly distribution: string;
  readonly version: string;
  readonly idempotencyKey: string;
  readonly status: "complete";
  readonly collectedAt: string;
  readonly evidence: unknown;
  readonly coverage: readonly { evidenceKind: string; state: "COMPLETE"; itemsObserved: number }[];
}

const K8S_ALL_KINDS = [
  "Workload", "Service", "Ingress", "RbacRole", "RbacBinding", "ServiceAccount", "Namespace", "NetworkPolicy",
] as const;

/**
 * One COMPLETE single-cluster Kubernetes evidence snapshot covering all eight
 * evidence kinds, with numeric pod requests on the workloads and a Node side
 * array carrying allocatable capacity + instance types — so posture renders AND
 * the FinOps K8s cost-allocation projection can price real per-namespace dollars.
 */
export function buildDemoKubernetesScan(): DemoKubernetesScan {
  const clusterUid = "northstar-prod-eks";
  const collectedAt = "2026-07-17T10:00:00.000Z";
  const resources: unknown[] = [
    { kind: "Namespace", name: K8S_NAMESPACE_PAYMENTS, namespace: null, podSecurityEnforce: "restricted", podSecurityWarn: "restricted", podSecurityAudit: "restricted" },
    { kind: "Namespace", name: K8S_NAMESPACE_STOREFRONT, namespace: null, podSecurityEnforce: "baseline", podSecurityWarn: "restricted", podSecurityAudit: "restricted" },
    workload(K8S_NAMESPACE_PAYMENTS, "orders-api", 500, 536_870_912, "a"),
    workload(K8S_NAMESPACE_PAYMENTS, "ledger-worker", 750, 1_073_741_824, "b"),
    workload(K8S_NAMESPACE_STOREFRONT, "web", 1_000, 2_147_483_648, "c"),
    { kind: "Service", namespace: K8S_NAMESPACE_PAYMENTS, name: "orders-api", serviceType: "ClusterIP", externalAddressCount: 0 },
    { kind: "Ingress", namespace: K8S_NAMESPACE_STOREFRONT, name: "web", ruleHosts: ["shop.example.com"], tlsHosts: ["shop.example.com"] },
    { kind: "RbacRole", namespace: K8S_NAMESPACE_PAYMENTS, name: "orders-reader", clusterScoped: false, rules: [{ verbs: ["get", "list"], apiGroups: [""], resources: ["pods", "configmaps"] }] },
    {
      kind: "RbacBinding", namespace: K8S_NAMESPACE_PAYMENTS, name: "orders-reader-binding", clusterScoped: false,
      roleRefKind: "Role", roleRefName: "orders-reader",
      subjects: [{ kind: "ServiceAccount", namespace: K8S_NAMESPACE_PAYMENTS, name: "orders-api" }],
    },
    { kind: "ServiceAccount", namespace: K8S_NAMESPACE_PAYMENTS, name: "orders-api", iamRoleArn: `arn:aws:iam::${DEMO_ACCOUNT_ID}:role/orders-api` },
    { kind: "NetworkPolicy", namespace: K8S_NAMESPACE_PAYMENTS, name: "default-deny", coversAllPods: true },
  ];
  const evidence = {
    schema: "sutra.kubernetes-evidence.v1",
    clusterId: clusterUid,
    collectedAt,
    observedKinds: [...K8S_ALL_KINDS],
    resources,
    nodes: [
      { name: "ip-10-0-1-11.ec2.internal", allocatableCpuMillicores: 4_000, allocatableMemoryBytes: 17_179_869_184, instanceType: "m5.xlarge" },
      { name: "ip-10-0-1-12.ec2.internal", allocatableCpuMillicores: 4_000, allocatableMemoryBytes: 17_179_869_184, instanceType: "m5.xlarge" },
      { name: "ip-10-0-1-13.ec2.internal", allocatableCpuMillicores: 2_000, allocatableMemoryBytes: 4_294_967_296, instanceType: "c5.large" },
    ],
  };
  const kindCounts = new Map<string, number>();
  for (const resource of resources) {
    const kind = (resource as { kind: string }).kind;
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const coverage = K8S_ALL_KINDS.map((evidenceKind) => ({
    evidenceKind,
    state: "COMPLETE" as const,
    itemsObserved: kindCounts.get(evidenceKind) ?? 0,
  }));
  return {
    clusterUid,
    clusterName: "Northstar Production",
    distribution: "eks",
    version: "1.34",
    idempotencyKey: "demo-northstar-scan-0001",
    status: "complete",
    collectedAt,
    evidence,
    coverage,
  };
}
