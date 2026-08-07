import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { authorize } from "../../../../lib/auth-policy";
import { getConnectionForOrg, LOCAL_ORG_ID } from "../../../../db/pilot-repository";
import { assertLocalSimulationRuntime, errorResponse, getLocalFixtureCatalog, jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    assertLocalSimulationRuntime();
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "workspace:read");
    const catalog = await getLocalFixtureCatalog();
    if (catalog.some((fixture) => fixture.tenantId !== authenticated.subject.orgId)) {
      throw Object.assign(new Error("The local fixture catalog is outside this workspace"), { code: "INVALID_STATE" });
    }
    const canCreateCustomer = authorize(authenticated.subject, {
      orgId: authenticated.subject.orgId,
      capability: "customer:create",
    }).allowed;
    const visible = catalog.filter((fixture) => authorize(authenticated.subject, {
      orgId: authenticated.subject.orgId,
      capability: "connection:read",
      customerId: fixture.customerId,
    }).allowed);
    const fixtures = await Promise.all(visible.map(async (fixture) => {
      const canRun = authorize(authenticated.subject, {
        orgId: authenticated.subject.orgId,
        capability: "sync:run",
        customerId: fixture.customerId,
      }).allowed;
      const canManageConnection = authorize(authenticated.subject, {
        orgId: authenticated.subject.orgId,
        capability: "connection:manage",
        customerId: fixture.customerId,
      }).allowed;
      const connection = await getConnectionForOrg(LOCAL_ORG_ID, fixture.connectionId);
      if (connection !== null && (
        connection.customerId !== fixture.customerId ||
        connection.sourceKind !== "simulated_fixture" ||
        connection.fixtureId !== fixture.fixtureId
      )) {
        throw Object.assign(new Error("The simulated fixture connection scope is inconsistent"), {
          code: "INVALID_STATE",
        });
      }
      const connectionExists = connection !== null;
      const connectionActive = connection?.status === "active";
      const canProvision = !connectionExists && canCreateCustomer && canManageConnection;
      return {
        ...fixture,
        canRun: canRun && (connectionActive || canProvision),
        canManageSchedule:
          canRun && canManageConnection && (connectionActive || canProvision),
        canPauseSchedule: canRun && canManageConnection && connectionExists,
        canPublish: canRun && (connectionActive || canProvision),
      };
    }));
    return jsonResponse({ fixtures });
  } catch (error) {
    return errorResponse(error);
  }
}
