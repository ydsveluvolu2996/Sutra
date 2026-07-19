import { getLatestConnectionForOrg } from "../../../../../db/pilot-repository";
import { collectComplianceInputs } from "../../../../../lib/compliance-collected";
import { buildFrameworkReadiness, COMPLIANCE_FRAMEWORKS } from "../../../../../lib/compliance-frameworks";
import { ApiTokenRepository } from "../../../../../db/api-token-repository";
import { authenticatePublicRequest, publicError, publicJson, PublicApiError } from "../../../../../lib/public-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const token = await authenticatePublicRequest(request, "read:compliance", new ApiTokenRepository());
    const connection = await getLatestConnectionForOrg(token.orgId);
    if (connection === null || connection.customerId !== token.customerId) {
      throw new PublicApiError(404, "NOT_FOUND", "No cloud connection is available to this token");
    }
    const inputs = await collectComplianceInputs({
      orgId: token.orgId,
      customerId: token.customerId,
      connectionId: connection.id,
    });
    const frameworks = COMPLIANCE_FRAMEWORKS.map((framework) => {
      const readiness = buildFrameworkReadiness(inputs.collected, framework.id, inputs.readinessScope);
      return {
        id: framework.id,
        title: framework.title,
        summary: readiness.summary,
        disclaimer: readiness.disclaimer,
      };
    });
    return publicJson({ scope: inputs.readinessScope, frameworks });
  } catch (error) {
    return publicError(error);
  }
}
