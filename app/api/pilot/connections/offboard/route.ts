import { requireRecentMfa } from "../../../../../db/auth-repository";
import {
  getConnectionForOrg,
  offboardAwsConnection,
} from "../../../../../db/pilot-repository";
import {
  assertSameOrigin,
  assertOffboardAccountConfirmation,
  parseOffboardConnectionRequest,
  readBoundedJson,
} from "../../../../../lib/aws-pilot-security";
import {
  errorResponse,
  jsonResponse,
  offboardCollectorConnection,
  requirePilotActor,
} from "../../../../../lib/pilot-server";
import { assertSessionCapability } from "../../../../../lib/api-auth";
import { applyControlPlaneLifecycleThenReconcileCollector } from "../../../../../lib/local-aws-lifecycle";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    assertSameOrigin(request);
    const body = parseOffboardConnectionRequest(await readBoundedJson(request));
    const connectionId = body.connectionId;
    const current = await getConnectionForOrg(actor.orgId, connectionId);
    if (current === null) {
      throw Object.assign(new Error("AWS connection not found"), { code: "NOT_FOUND" });
    }
    assertSessionCapability(actor.authenticated, "connection:manage", current.customerId);
    assertOffboardAccountConfirmation(body.awsAccountId, current.awsAccountId);
    if (current.sourceKind !== "aws_trust_role") {
      throw Object.assign(new Error("Simulation connections use the simulation controls"), { code: "INVALID_STATE" });
    }
    const alreadyOffboarded = current.status === "disabled" && current.roleArn === null;
    if (!alreadyOffboarded) requireRecentMfa(actor.authenticated);
    const result = await applyControlPlaneLifecycleThenReconcileCollector({
      transitionControlPlane: () => offboardAwsConnection(connectionId, actor.id),
      reconcileCollector: () => offboardCollectorConnection({ tenantId: actor.orgId, connectionId }),
    });
    return jsonResponse({
      connection: result.connection,
      offboarded: true,
      cmdbHistoryRetained: true,
      collectorCleanup: result.collectorCleanup,
      customerIamRoleRevocationRequired: true,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
