import { getLatestConnectionForOrg } from "../../../../../db/pilot-repository";
import { CloudVulnerabilityRepository } from "../../../../../db/cloud-vulnerability-repository";
import { ApiTokenRepository } from "../../../../../db/api-token-repository";
import { authenticatePublicRequest, decodeCursor, paginate, parsePageSize, publicError, publicJson, PublicApiError } from "../../../../../lib/public-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const token = await authenticatePublicRequest(request, "read:vulnerabilities", new ApiTokenRepository());
    const url = new URL(request.url);
    const offset = decodeCursor(url.searchParams.get("cursor"));
    const limit = parsePageSize(url.searchParams.get("limit"));
    const connection = await getLatestConnectionForOrg(token.orgId);
    if (connection === null || connection.customerId !== token.customerId) {
      throw new PublicApiError(404, "NOT_FOUND", "No cloud connection is available to this token");
    }
    const repository = new CloudVulnerabilityRepository();
    const findings = await repository.listForConnection(
      { orgId: token.orgId, customerId: token.customerId },
      connection.id,
    );
    const { page, nextCursor } = paginate(findings, offset, limit);
    return publicJson(page, { nextCursor });
  } catch (error) {
    return publicError(error);
  }
}
