import {
  disableAwsConnection,
  getConnection,
  LOCAL_ORG_ID,
} from "../../../../../db/pilot-repository";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import {
  disableCollectorConnection,
  errorResponse,
  jsonResponse,
  requirePilotActor,
} from "../../../../../lib/pilot-server";
import { assertSessionCapability } from "../../../../../lib/api-auth";
import { applyControlPlaneLifecycleThenReconcileCollector } from "../../../../../lib/local-aws-lifecycle";

export const dynamic = "force-dynamic";

function connectionIdFrom(value: unknown): string {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).length !== 1 || !("connectionId" in value) ||
    typeof (value as { connectionId?: unknown }).connectionId !== "string" ||
    !/^conn_[a-f0-9]{32}$/u.test((value as { connectionId: string }).connectionId)
  ) {
    throw Object.assign(new Error("The disable request is invalid"), { code: "INVALID_INPUT" });
  }
  return (value as { connectionId: string }).connectionId;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    assertSameOrigin(request);
    const connectionId = connectionIdFrom(await readBoundedJson(request));
    const current = await getConnection(connectionId);
    if (current === null) {
      throw Object.assign(new Error("AWS connection not found"), { code: "NOT_FOUND" });
    }
    assertSessionCapability(actor.authenticated, "connection:manage", current.customerId);
    if (current.sourceKind !== "aws_trust_role") {
      throw Object.assign(new Error("Simulation connections use the simulation controls"), { code: "INVALID_STATE" });
    }
    const result = await applyControlPlaneLifecycleThenReconcileCollector({
      transitionControlPlane: () => disableAwsConnection(connectionId, actor.id),
      reconcileCollector: () => disableCollectorConnection({ tenantId: LOCAL_ORG_ID, connectionId }),
    });
    return jsonResponse({
      connection: result.connection,
      disabled: true,
      collectorCleanup: result.collectorCleanup,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
