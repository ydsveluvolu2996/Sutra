import { getConnectionForOrg, getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { buildAiCostView } from "../../../../../lib/finops-ai-cost";
import { buildGpuCostView, type GpuUtilizationSample } from "../../../../../lib/finops-gpu-cost";
import type { NormalizedCurLine } from "../../../../../lib/finops-cur";
import type { PilotResource } from "../../../../../lib/pilot-types";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BILLING_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;

/**
 * AI/LLM token cost + GPU/accelerator cost for one connection's ingested billing
 * data. Tenancy is session-derived: the connection is resolved inside the
 * session's org and the read is gated on `connection:read` for that connection's
 * customer, exactly as the amortized route does.
 *
 * Both blocks carry their own `available` flag and reason. Neither engine
 * fabricates: token counts appear only where the billing file metered them, and
 * GPU idleness is never claimed because no GPU utilisation collector exists (an
 * EMPTY sample set is passed deliberately — see lib/finops-gpu-cost.ts).
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const period = url.searchParams.get("period");
    if (!CONNECTION_ID.test(connectionId) || (period !== null && !BILLING_PERIOD.test(period))) {
      throw Object.assign(new Error("The FinOps AI/GPU cost request is invalid"), { code: "INVALID_INPUT" });
    }
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const repository = new FinopsWorkspaceRepository();
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const periods = await repository.listPeriods(scope, connectionId);
    // CMDB resources for this connection (tenant-scoped through the resolved
    // connection). The GPU inventory comes from these and does not depend on the
    // billing file, so it is reported even with no CUR uploaded.
    const resources: readonly PilotResource[] =
      (await getPilotStateForOrg(authenticated.subject.orgId, connectionId)).resources;
    // GPU utilisation samples: there is no DCGM/nvidia-smi collector, so this is
    // deliberately EMPTY and the engine reports idle detection as unavailable
    // rather than inferring idleness from CPU metrics.
    const utilization: readonly GpuUtilizationSample[] = [];
    const selected = period ?? periods[0]?.period ?? null;
    if (selected === null) {
      return jsonResponse({
        connectionId,
        periods,
        period: null,
        lineCount: 0,
        ai: buildAiCostView([]),
        gpu: buildGpuCostView({ curLines: [], resources, utilization }),
      });
    }
    const lines = await repository.linesForPeriod(scope, connectionId, selected);
    // Per-model AI spend TREND is inherently multi-period, so the AI view reads
    // every persisted period's lines; GPU spend is scoped to the selected period.
    const allPeriodLines: readonly NormalizedCurLine[] = (
      await Promise.all(periods.map((entry) => repository.linesForPeriod(scope, connectionId, entry.period)))
    ).flat();
    return jsonResponse({
      connectionId,
      periods,
      period: selected,
      lineCount: lines.length,
      ai: buildAiCostView(allPeriodLines),
      gpu: buildGpuCostView({ curLines: lines, resources, utilization }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
