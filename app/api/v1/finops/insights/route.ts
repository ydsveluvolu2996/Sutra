import { getConnectionForOrg, getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { buildAllocation, detectAnomalies, evaluateBudgets } from "../../../../../lib/finops-insights";
import { buildCostOptimizations } from "../../../../../lib/aws-cost-optimization";
import { buildRightsizingRecommendations } from "../../../../../lib/finops-rightsizing";
import { buildRightsizingInput, type CollectedUtilizationSample } from "../../../../../lib/finops-rightsizing-inputs";
import { buildIdleWaste } from "../../../../../lib/finops-idle-waste";
import { buildIdleWasteInputs } from "../../../../../lib/finops-idle-waste-inputs";
import { buildTagGovernance } from "../../../../../lib/finops-tag-governance";
import { buildTagGovernanceInputs } from "../../../../../lib/finops-tag-governance-inputs";
import { buildCostTrends } from "../../../../../lib/finops-trends";
import { buildCostTrendsInput } from "../../../../../lib/finops-trends-inputs";
import { buildSavingsTracking } from "../../../../../lib/finops-savings-tracking";
import { buildSavingsTrackingInput } from "../../../../../lib/finops-savings-tracking-inputs";
import { buildUnitEconomics } from "../../../../../lib/finops-unit-economics";
import { buildUnitEconomicsInput } from "../../../../../lib/finops-unit-economics-inputs";
import { FinopsUnitCountRepository } from "../../../../../db/finops-unit-count-repository";
import { buildKubernetesAllocation, K8S_ALLOCATION_DISCLAIMER } from "../../../../../lib/finops-k8s-allocation";
import { buildKubernetesAllocationInput } from "../../../../../lib/finops-k8s-allocation-inputs";
import { projectKubernetesAllocationInput } from "../../../../../lib/finops-k8s-allocation-projection";
import { KubernetesRepository } from "../../../../../db/kubernetes-repository";
import type { NormalizedCurLine } from "../../../../../lib/finops-cur";
import type { PilotResource } from "../../../../../lib/pilot-types";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BILLING_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;
const TAG_KEY = /^[\p{L}\p{N}][\p{L}\p{N} ._:/-]{0,63}$/u;

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const period = url.searchParams.get("period");
    const dimension = url.searchParams.get("dimension") ?? "service";
    const tagKey = url.searchParams.get("tagKey");
    if (
      !CONNECTION_ID.test(connectionId) ||
      (period !== null && !BILLING_PERIOD.test(period)) ||
      (dimension !== "service" && dimension !== "account" && dimension !== "tag") ||
      (dimension === "tag" && (tagKey === null || !TAG_KEY.test(tagKey)))
    ) {
      throw Object.assign(new Error("The FinOps insight request is invalid"), { code: "INVALID_INPUT" });
    }
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const repository = new FinopsWorkspaceRepository();
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const periods = await repository.listPeriods(scope, connectionId);
    // CMDB resources for this connection (tenant-scoped through the resolved
    // connection). Idle/waste and tag governance are derived from these plus the
    // selected period's CUR lines; both are honest with no CUR present.
    const resources: readonly PilotResource[] =
      (await getPilotStateForOrg(authenticated.subject.orgId, connectionId)).resources;
    const governanceBlocks = (lines: readonly NormalizedCurLine[]) => ({
      idleWaste: buildIdleWaste(buildIdleWasteInputs({ resources, curLines: lines })),
      tagGovernance: buildTagGovernance(buildTagGovernanceInputs({ resources, curLines: lines })),
    });
    // Trends, forecasting and realized-savings are inherently multi-period, so
    // they read EVERY persisted period's CUR lines — not just the selected one.
    // With no periods the line set is empty and both engines report an honest
    // empty result. A real clock lets them flag the current in-progress month.
    const allPeriodLines: readonly NormalizedCurLine[] = (
      await Promise.all(periods.map((entry) => repository.linesForPeriod(scope, connectionId, entry.period)))
    ).flat();
    const trendBlocks = {
      trends: buildCostTrends(buildCostTrendsInput({ curLines: allPeriodLines }), { now: () => new Date() }),
      savings: buildSavingsTracking(buildSavingsTrackingInput({ curLines: allPeriodLines }), { now: () => new Date() }),
    };
    // #3 Kubernetes cost allocation: split each of this customer's cluster node
    // costs across namespaces by collected pod requests. Node cost comes from a
    // disclosed bundled instance-type price catalog; a cluster with no priced
    // nodes is honestly reported as node-cost-not-derivable. Independent of the
    // billing period (uses node list-price, not CUR).
    const k8sRepo = new KubernetesRepository();
    const k8sClusters = await k8sRepo.listClusters(scope);
    const k8sAllocationClusters = (
      await Promise.all(k8sClusters.map(async (cluster) => {
        const evidence = await k8sRepo.getLatestAllocationEvidence(scope, cluster.id);
        if (evidence === null) return null;
        const projection = projectKubernetesAllocationInput(evidence);
        const report = buildKubernetesAllocation(buildKubernetesAllocationInput(projection));
        const allocation = report.clusters[0];
        if (allocation === undefined) return null;
        return { clusterName: cluster.name, costCatalogCoverage: projection.costCatalogCoverage, allocation };
      }))
    ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const kubernetesAllocation = { clusters: k8sAllocationClusters, disclaimer: K8S_ALLOCATION_DISCLAIMER };
    const selected = period ?? periods[0]?.period ?? null;
    if (selected === null) {
      return jsonResponse({
        connectionId,
        periods,
        period: null,
        allocation: [],
        budgets: [],
        anomalies: null,
        ...governanceBlocks([]),
        ...trendBlocks,
        kubernetesAllocation,
        unitCountsPeriod: null,
        unitEconomics: [],
      });
    }
    const lines = await repository.linesForPeriod(scope, connectionId, selected);
    const budgets = await repository.listBudgets(scope);
    // Commitment + rightsizing candidates are derived from the ingested CUR
    // lines only (no snapshot/CMDB here); the engine returns only those two
    // categories when given curLines with no snapshot or resources.
    const optimizations = buildCostOptimizations({ snapshot: null, resources: [], curLines: lines });
    // Utilization-based rightsizing over collected CloudWatch samples. Samples are
    // supplied by the collector's CloudWatch runner; until a utilization
    // collection is persisted for this connection the sample set is empty and the
    // engine honestly reports no recommendations (never a fabricated saving).
    const utilizationSamples: readonly CollectedUtilizationSample[] = [];
    const rightsizingReport = buildRightsizingRecommendations(
      buildRightsizingInput({ utilization: utilizationSamples, curLines: lines }),
    );
    // #10 unit economics: operator-provided per-customer unit counts (transactions,
    // seats, ...) for this period turned into a cost-per-unit. Counts are never
    // assumed — an absent or zero count yields a disclosed null ratio, never a
    // divide-by-zero. One report per stored unit label.
    const unitCounts = await new FinopsUnitCountRepository().list(scope, { period: selected });
    const periodCurrencies = [...new Set(lines.map((line) => line.currency))].filter((code) => /^[A-Z]{3}$/u.test(code));
    const accountToCustomer = { [connection.awsAccountId]: connection.customerId };
    const unitEconomics = unitCounts.map((entry) => ({
      unitLabel: entry.unitLabel,
      count: entry.count,
      report: buildUnitEconomics(buildUnitEconomicsInput({
        curLines: lines,
        accountToCustomer,
        customerUnits: periodCurrencies.map((currency) => ({ customerId: connection.customerId, currency, count: entry.count })),
        unitLabel: entry.unitLabel,
      })),
    }));
    return jsonResponse({
      connectionId,
      periods,
      period: selected,
      lineCount: lines.length,
      allocation: buildAllocation(lines, dimension, dimension === "tag" ? tagKey : null),
      budgets: evaluateBudgets(lines, budgets),
      anomalies: detectAnomalies(lines),
      commitment: {
        recommendations: optimizations.recommendations,
        savingsByCurrencyMicros: optimizations.summary.commitmentSavingsByCurrencyMicros,
        limitations: optimizations.limitations,
        disclaimer: optimizations.disclaimer,
      },
      rightsizing: {
        recommendations: rightsizingReport.recommendations,
        summary: rightsizingReport.summary,
        limitations: rightsizingReport.limitations,
        disclaimer: rightsizingReport.disclaimer,
      },
      ...governanceBlocks(lines),
      ...trendBlocks,
      kubernetesAllocation,
      unitCountsPeriod: selected,
      unitEconomics,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
