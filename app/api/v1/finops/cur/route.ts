import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { parseCurCsv } from "../../../../../lib/finops-cur";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BILLING_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) {
      throw Object.assign(new Error("The CUR upload is invalid"), { code: "INVALID_INPUT" });
    }
    const { connectionId, billingPeriod, csv } = body as { connectionId?: unknown; billingPeriod?: unknown; csv?: unknown };
    if (
      typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId) ||
      typeof billingPeriod !== "string" || !BILLING_PERIOD.test(billingPeriod) ||
      typeof csv !== "string" || csv.length === 0 || csv.length > MAX_UPLOAD_BYTES
    ) {
      throw Object.assign(new Error("The CUR upload is invalid"), { code: "INVALID_INPUT" });
    }
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:manage", connection.customerId);
    const parsed = parseCurCsv(csv);
    if ("error" in parsed) {
      throw Object.assign(new Error(parsed.error), { code: "INVALID_INPUT" });
    }
    if (parsed.lines.length === 0) {
      throw Object.assign(new Error("No rows were accepted; every row was rejected — nothing was stored"), { code: "INVALID_INPUT" });
    }
    const repository = new FinopsWorkspaceRepository();
    const summary = await repository.replacePeriod(
      { orgId: authenticated.subject.orgId, customerId: connection.customerId },
      connectionId,
      billingPeriod,
      parsed.lines,
    );
    return jsonResponse({
      summary,
      dialect: parsed.dialect,
      accepted: parsed.lines.length,
      rejected: parsed.rejected.slice(0, 50),
      rejectedCount: parsed.rejected.length,
      currencies: parsed.currencies,
      disclaimer: parsed.disclaimer,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
