import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { ComplianceWorkspaceRepository } from "../../../../../db/compliance-workspace-repository";
import { buildCustomFrameworkReadiness } from "../../../../../lib/compliance-custom-framework";
import { collectComplianceInputs } from "../../../../../lib/compliance-collected";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CUSTOM_FRAMEWORK_ID = /^cf_[a-f0-9]{32}$/u;

async function resolveConnection(request: Request, connectionId: string, capability: "connection:read" | "connection:manage") {
  if (!CONNECTION_ID.test(connectionId)) {
    throw Object.assign(new Error("The custom-framework request is invalid"), { code: "INVALID_INPUT" });
  }
  const authenticated = await requireApiSession(request);
  const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
  if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
  assertSessionCapability(authenticated, capability, connection.customerId);
  return { authenticated, connection, scope: { orgId: authenticated.subject.orgId, customerId: connection.customerId } };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const { scope } = await resolveConnection(request, connectionId, "connection:read");
    const repository = new ComplianceWorkspaceRepository();
    const stored = await repository.listCustomFrameworks(scope);
    const inputs = await collectComplianceInputs({ orgId: scope.orgId, customerId: scope.customerId, connectionId });
    const frameworks = stored.map((entry) => ({
      id: entry.id,
      updatedAt: entry.updatedAt,
      definition: entry.definition,
      readiness: buildCustomFrameworkReadiness(inputs.collected, entry.definition, inputs.readinessScope),
    }));
    return jsonResponse({ connectionId, frameworks });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) {
      throw Object.assign(new Error("The custom-framework request is invalid"), { code: "INVALID_INPUT" });
    }
    const { connectionId, definition } = body as { connectionId?: unknown; definition?: unknown };
    if (typeof connectionId !== "string") {
      throw Object.assign(new Error("The custom-framework request is invalid"), { code: "INVALID_INPUT" });
    }
    const { authenticated, scope } = await resolveConnection(request, connectionId, "connection:manage");
    const repository = new ComplianceWorkspaceRepository();
    const saved = await repository.saveCustomFramework(scope, definition, authenticated.subject.userId);
    return jsonResponse({ saved: { id: saved.id, name: saved.definition.name, updatedAt: saved.updatedAt } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const id = url.searchParams.get("id") ?? "";
    if (!CUSTOM_FRAMEWORK_ID.test(id)) {
      throw Object.assign(new Error("The custom-framework request is invalid"), { code: "INVALID_INPUT" });
    }
    const { scope } = await resolveConnection(request, connectionId, "connection:manage");
    const repository = new ComplianceWorkspaceRepository();
    const deleted = await repository.deleteCustomFramework(scope, id);
    return jsonResponse({ deleted });
  } catch (error) {
    return errorResponse(error);
  }
}
