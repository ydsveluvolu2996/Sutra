import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { ComplianceWorkspaceRepository } from "../../../../../db/compliance-workspace-repository";
import { buildComplianceTrend } from "../../../../../lib/compliance-trend";
import { COMPLIANCE_FRAMEWORKS, type ComplianceFrameworkId } from "../../../../../lib/compliance-frameworks";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const FRAMEWORK_IDS = new Set<string>(COMPLIANCE_FRAMEWORKS.map((framework) => framework.id));

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const frameworkId = url.searchParams.get("framework") ?? "";
    if (!CONNECTION_ID.test(connectionId) || !FRAMEWORK_IDS.has(frameworkId)) {
      throw Object.assign(new Error("The compliance-trend request is invalid"), { code: "INVALID_INPUT" });
    }
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const repository = new ComplianceWorkspaceRepository();
    const points = await repository.listTrendPoints(
      { orgId: authenticated.subject.orgId, customerId: connection.customerId },
      connectionId,
      frameworkId as ComplianceFrameworkId,
    );
    return jsonResponse({ connectionId, frameworkId, trend: buildComplianceTrend(points) });
  } catch (error) {
    return errorResponse(error);
  }
}
