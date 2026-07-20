import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { CmdbWorkspaceRepository } from "../../../../../db/cmdb-workspace-repository";
import { CmdbCustomAssetRepository } from "../../../../../db/cmdb-custom-asset-repository";
import { toCmdbResource } from "../../../../../lib/cmdb-custom-assets";
import { runCmdbQuery, validateCmdbQuery } from "../../../../../lib/cmdb-query";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) {
      throw Object.assign(new Error("The query request is invalid"), { code: "INVALID_INPUT" });
    }
    const { connectionId, query } = body as { connectionId?: unknown; query?: unknown };
    if (typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId)) {
      throw Object.assign(new Error("The query request is invalid"), { code: "INVALID_INPUT" });
    }
    const validation = validateCmdbQuery(query);
    if (validation.query === null) {
      throw Object.assign(new Error(`The query is invalid: ${validation.errors.join("; ")}`), { code: "INVALID_INPUT" });
    }
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    }
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const repository = new CmdbWorkspaceRepository();
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const resources = await repository.resourcesForQuery(scope, connectionId);
    // Imported custom/external assets (SaaS, network devices, on-prem) are
    // first-class CMDB items — merge them so they are searchable alongside
    // collected AWS resources. They are user-supplied and source-labeled.
    const customAssets = (await new CmdbCustomAssetRepository().list(scope)).map((asset) => toCmdbResource(asset));
    const result = runCmdbQuery([...resources, ...customAssets], validation.query);
    return jsonResponse({
      connectionId,
      result: {
        matched: result.matched,
        totalMatched: result.totalMatched,
        evaluated: result.evaluated,
        truncated: result.truncated,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
