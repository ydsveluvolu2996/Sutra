import { getLatestConnectionForCustomer, getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { ApiTokenRepository } from "../../../../../db/api-token-repository";
import { authenticatePublicRequest, publicError, publicJson, PublicApiError } from "../../../../../lib/public-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const token = await authenticatePublicRequest(request, "read:snapshots", new ApiTokenRepository());
    const connection = await getLatestConnectionForCustomer(token.orgId, token.customerId);
    if (connection === null) {
      throw new PublicApiError(404, "NOT_FOUND", "No cloud connection is available to this token");
    }
    const state = await getPilotStateForOrg(token.orgId, connection.id);
    return publicJson({
      activeSnapshot: state.activeSnapshot,
      coverage: state.coverage,
      syncRuns: state.syncRuns.slice(0, 20),
    });
  } catch (error) {
    return publicError(error);
  }
}
