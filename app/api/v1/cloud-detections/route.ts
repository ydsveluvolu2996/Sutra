import { getSecurityEventsWorkspace } from "../../../../db/security-event-repository";
import { getConnectionForOrg } from "../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { buildCloudDetections } from "../../../../lib/cloud-detection";
import { buildCloudDetectionInputs } from "../../../../lib/cloud-detection-inputs";
import { errorResponse, jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
// The engine analyzes the most-recent bounded window; the repository caps the
// query at 200, so at most that many events feed a single evaluation.
const EVENT_LIMIT = 200;

function invalid(): never {
  throw Object.assign(new Error("The cloud-detection request is invalid"), { code: "INVALID_INPUT" });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) invalid();
    const connectionId = url.searchParams.get("connectionId");
    if (connectionId === null || !CONNECTION_ID.test(connectionId)) invalid();

    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);

    // Feed only the already-collected, tenant-scoped CloudTrail management
    // events; the adapter maps them and declares single-source coverage.
    const workspace = await getSecurityEventsWorkspace({
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId,
      limit: EVENT_LIMIT,
    });
    const inputs = buildCloudDetectionInputs(workspace.events, { tenant: connection.customerId });
    const report = buildCloudDetections(inputs.events);

    return jsonResponse({
      report,
      coverage: inputs.coverage,
      source: {
        collected: workspace.source !== null,
        status: workspace.source?.status ?? "NOT_COLLECTED",
        eventsAnalyzed: inputs.coverage.eventsIngested,
        totalEventsStored: workspace.counts.totalEvents,
        lastCollectedAt: workspace.source?.lastCollectedAt ?? null,
        windowStart: workspace.latestRun?.windowStart ?? null,
        windowEnd: workspace.latestRun?.windowEnd ?? null,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
