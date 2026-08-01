import { DcfRepository } from "../../../../../db/finops-dcf-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import {
  assertSessionCapability,
  requireApiSession,
} from "../../../../../lib/api-auth";
import { buildDcfDashboard } from "../../../../../lib/finops-dcf-execution-history";
import { DATA_COLLECTION_MONITOR_OFFICIAL_DEFINITION } from "../../../../../lib/finops-data-collection-monitor-official-definition";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";
export async function GET(request: Request) {
  try {
    const p = new URL(request.url).searchParams,
      id = p.get("connectionId") ?? "";
    if (p.size !== 1 || !/^conn_[a-f0-9]{32}$/u.test(id))
      throw Object.assign(new Error("invalid"), {
        status: 400,
        code: "INVALID_INPUT",
      });
    const auth = await requireApiSession(request),
      connection = await getConnectionForOrg(auth.subject.orgId, id);
    if (!connection)
      throw Object.assign(new Error("not found"), {
        status: 404,
        code: "NOT_FOUND",
      });
    assertSessionCapability(auth, "connection:read", connection.customerId);
    const scope = {
        organizationId: auth.subject.orgId,
        customerId: connection.customerId,
        connectionId: id,
      },
      heads = await new DcfRepository().listAcceptedHistory(scope);
    if (!heads.length)
      return jsonResponse({
        connectionId: id,
        officialDefinition: DATA_COLLECTION_MONITOR_OFFICIAL_DEFINITION,
        dashboard: null,
        collection: {
          available: false,
          reason: "DCF_STEP_FUNCTIONS_INSTRUMENTATION_NOT_REGISTERED",
        },
      });
    return jsonResponse({
      connectionId: id,
      officialDefinition: DATA_COLLECTION_MONITOR_OFFICIAL_DEFINITION,
      ...buildDcfDashboard(heads),
      collection: {
        available: false,
        reason: "DCF_STEP_FUNCTIONS_INSTRUMENTATION_NOT_REGISTERED",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
