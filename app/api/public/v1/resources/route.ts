import { getLatestConnectionForOrg } from "../../../../../db/pilot-repository";
import { CmdbWorkspaceRepository } from "../../../../../db/cmdb-workspace-repository";
import { ApiTokenRepository } from "../../../../../db/api-token-repository";
import { authenticatePublicRequest, decodeCursor, paginate, parsePageSize, publicError, publicJson, PublicApiError } from "../../../../../lib/public-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const token = await authenticatePublicRequest(request, "read:resources", new ApiTokenRepository());
    const url = new URL(request.url);
    const offset = decodeCursor(url.searchParams.get("cursor"));
    const limit = parsePageSize(url.searchParams.get("limit"));
    const connection = await getLatestConnectionForOrg(token.orgId);
    if (connection === null || connection.customerId !== token.customerId) {
      throw new PublicApiError(404, "NOT_FOUND", "No cloud connection is available to this token");
    }
    const repository = new CmdbWorkspaceRepository();
    const resources = await repository.resourcesForQuery(
      { orgId: token.orgId, customerId: token.customerId },
      connection.id,
    );
    const { page, nextCursor } = paginate(resources, offset, limit);
    return publicJson(page.map((resource) => ({
      resourceKey: resource.resourceKey,
      service: resource.service,
      resourceType: resource.resourceType,
      region: resource.regionKey,
      name: resource.name,
      state: resource.state,
      arn: resource.arn,
      nativeId: resource.nativeId,
      tags: resource.tags,
    })), { nextCursor });
  } catch (error) {
    return publicError(error);
  }
}
