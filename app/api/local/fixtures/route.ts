import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { authorize } from "../../../../lib/auth-policy";
import { errorResponse, getLocalFixtureCatalog, jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "workspace:read");
    const catalog = await getLocalFixtureCatalog();
    if (catalog.some((fixture) => fixture.tenantId !== authenticated.subject.orgId)) {
      throw Object.assign(new Error("The local fixture catalog is outside this workspace"), { code: "INVALID_STATE" });
    }
    const fixtures = catalog.filter((fixture) => authorize(authenticated.subject, {
      orgId: authenticated.subject.orgId,
      capability: "sync:run",
      customerId: fixture.customerId,
    }).allowed);
    return jsonResponse({ fixtures });
  } catch (error) {
    return errorResponse(error);
  }
}
