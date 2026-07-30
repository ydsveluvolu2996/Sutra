import { getLatestConnectionForCustomer } from "../../../../../db/pilot-repository";
import { CmdbWorkspaceRepository } from "../../../../../db/cmdb-workspace-repository";
import { ApiTokenRepository } from "../../../../../db/api-token-repository";
import { authenticatePublicRequest, decodeCursor, paginate, parsePageSize, publicCursorContext, publicError, publicJson, PublicApiError } from "../../../../../lib/public-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const token = await authenticatePublicRequest(request, "read:resources", new ApiTokenRepository());
    const url = new URL(request.url);
    const cursorContext = publicCursorContext(request, token, "resources");
    const offset = await decodeCursor(url.searchParams.get("cursor"), cursorContext);
    const limit = parsePageSize(url.searchParams.get("limit"));
    const connection = await getLatestConnectionForCustomer(token.orgId, token.customerId);
    if (connection === null) {
      throw new PublicApiError(404, "NOT_FOUND", "No cloud connection is available to this token");
    }
    const repository = new CmdbWorkspaceRepository();
    const resources = await repository.resourcesForQuery(
      { orgId: token.orgId, customerId: token.customerId },
      connection.id,
    );
    const { page, nextCursor } = await paginate(resources, offset, limit, cursorContext);
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
      lifecycleState: resource.lifecycleState ?? "active",
      consecutiveCompleteMisses: resource.consecutiveCompleteMisses ?? 0,
      contentSha256: resource.contentSha256 ?? null,
      evidenceSnapshot: resource.evidenceSnapshotId === undefined
        ? null
        : {
            id: resource.evidenceSnapshotId,
            snapshotSha256: resource.evidenceSnapshotSha256 ?? null,
          },
    })), { nextCursor });
  } catch (error) {
    return publicError(error);
  }
}
