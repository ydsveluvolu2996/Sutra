import { isCollectableAwsSourceKind } from "../../../../../lib/aws-connection-source";
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
    if (!isCollectableAwsSourceKind(current.sourceKind)) {
      throw Object.assign(new Error("Simulation connections use the simulation controls"), { code: "INVALID_STATE" });
    }
    // A static-credential connection pins roleArn to the empty string for its
    // whole life, so an absent role ARN is not evidence that it was offboarded;
    // only the disabled status is. Trust-role connections keep the original
    // test, where offboarding is what clears the role ARN.
    const alreadyOffboarded = current.status === "disabled"
      && (current.sourceKind === "aws_static_credentials" || current.roleArn === null);
    if (!alreadyOffboarded) requireRecentMfa(actor.authenticated);
    const result = await applyControlPlaneLifecycleThenReconcileCollector({
      transitionControlPlane: () => offboardAwsConnection(connectionId, actor.id, actor.orgId),
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
