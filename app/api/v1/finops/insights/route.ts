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
    });
  } catch (error) {
    return errorResponse(error);
  }
}
