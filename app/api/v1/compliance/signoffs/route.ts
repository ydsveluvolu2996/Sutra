import { listComplianceExceptions } from "../../../../../db/compliance-exception-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { ComplianceWorkspaceRepository } from "../../../../../db/compliance-workspace-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { buildComplianceReport } from "../../../../../lib/compliance-report";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    if (!CONNECTION_ID.test(connectionId)) {
      throw Object.assign(new Error("The sign-off request is invalid"), { code: "INVALID_INPUT" });
    }
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const repository = new ComplianceWorkspaceRepository();
    const signoffs = await repository.listSignoffs(
      { orgId: authenticated.subject.orgId, customerId: connection.customerId },
      connectionId,
    );
    return jsonResponse({ connectionId, signoffs });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) {
      throw Object.assign(new Error("The sign-off request is invalid"), { code: "INVALID_INPUT" });
    }
    const { connectionId, reportSha256, decision, note } = body as {
      connectionId?: unknown; reportSha256?: unknown; decision?: unknown; note?: unknown;
    };
    if (
      typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId) ||
      typeof reportSha256 !== "string" || !SHA256_HEX.test(reportSha256) ||
      (decision !== "approved" && decision !== "needs-work") ||
      (note !== undefined && note !== null && typeof note !== "string")
    ) {
      throw Object.assign(new Error("The sign-off request is invalid"), { code: "INVALID_INPUT" });
    }
    // requireApiSession enforces MFA by default, so a recorded sign-off is
    // MFA-verified by construction — recorded explicitly all the same.
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:manage", connection.customerId);
    const [state, exceptions] = await Promise.all([
      getPilotStateForOrg(authenticated.subject.orgId, connectionId),
      listComplianceExceptions({
        orgId: authenticated.subject.orgId,
        customerId: connection.customerId,
        connectionId,
      }),
    ]);
    const currentReport = await buildComplianceReport(state, exceptions);
    if (reportSha256 !== currentReport.reportSha256) {
      throw Object.assign(
        new Error("The compliance report changed; refresh it before recording a sign-off"),
        { code: "INVALID_INPUT" },
      );
    }
    const repository = new ComplianceWorkspaceRepository();
    const signoff = await repository.recordSignoff(
      { orgId: authenticated.subject.orgId, customerId: connection.customerId },
      connectionId,
      reportSha256,
      decision,
      note ?? null,
      authenticated.subject.userId,
      true,
    );
    return jsonResponse({ signoff });
  } catch (error) {
    return errorResponse(error);
  }
}
