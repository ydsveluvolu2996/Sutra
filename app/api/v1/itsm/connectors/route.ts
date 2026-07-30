import { ItsmConnectorRepository } from "../../../../../db/itsm-connector-repository";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTOR_ID = /^itc_[a-f0-9]{32}$/u;

async function resolveScope(request: Request, capability: "connection:read" | "connection:manage") {
  return requireConnectionScope(request, capability);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope } = await resolveScope(request, "connection:read");
    return jsonResponse({ connectors: await new ItsmConnectorRepository().list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body: unknown = await readBoundedJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw Object.assign(new Error("The ITSM connector request is invalid"), { code: "INVALID_INPUT" });
    }
    const record = body as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !["name", "connectorType", "baseUrl", "projectKey", "sharedSecret", "enabled"].includes(key)) ||
      typeof record.name !== "string" ||
      (record.connectorType !== "jira" && record.connectorType !== "servicenow") ||
      typeof record.baseUrl !== "string" ||
      (record.projectKey !== null && record.projectKey !== undefined && typeof record.projectKey !== "string") ||
      typeof record.sharedSecret !== "string" ||
      (record.enabled !== undefined && typeof record.enabled !== "boolean")
    ) {
      throw Object.assign(new Error("The ITSM connector request is invalid"), { code: "INVALID_INPUT" });
    }
    const { authenticated, scope } = await resolveScope(request, "connection:manage");
    const repository = new ItsmConnectorRepository();
    const saved = await repository.save(scope, {
      name: record.name,
      connectorType: record.connectorType,
      baseUrl: record.baseUrl,
      projectKey: record.projectKey === undefined || record.projectKey === "" ? null : record.projectKey,
      sharedSecret: record.sharedSecret,
      enabled: record.enabled,
    }, authenticated.subject.userId);
    return jsonResponse({ saved, connectors: await repository.list(scope) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!CONNECTOR_ID.test(id)) throw Object.assign(new Error("The connector identifier is invalid"), { code: "INVALID_INPUT" });
    const { scope } = await resolveScope(request, "connection:manage");
    const repository = new ItsmConnectorRepository();
    const deleted = await repository.delete(scope, id);
    return jsonResponse({ deleted, connectors: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}
