import { addCaseNote, listFindingCases } from "../../../../../db/case-repository";
import { ItsmConnectorRepository } from "../../../../../db/itsm-connector-repository";
import { getLatestConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { buildOutboundTicket, signOutboundBody } from "../../../../../lib/itsm-sync";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTOR_ID = /^itc_[a-f0-9]{32}$/u;
const CASE_ID = /^case_[a-f0-9]{32}$/u;

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw Object.assign(new Error("The ITSM dispatch request is invalid"), { code: "INVALID_INPUT" });
    }
    const record = body as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !["connectorId", "caseId"].includes(key)) ||
      typeof record.connectorId !== "string" || !CONNECTOR_ID.test(record.connectorId) ||
      typeof record.caseId !== "string" || !CASE_ID.test(record.caseId)
    ) throw Object.assign(new Error("The ITSM dispatch request is invalid"), { code: "INVALID_INPUT" });
    const authenticated = await requireApiSession(request);
    const connection = await getLatestConnectionForOrg(authenticated.subject.orgId);
    if (connection === null) throw Object.assign(new Error("No cloud connection is configured"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:manage", connection.customerId);
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const repository = new ItsmConnectorRepository();
    const connector = await repository.getForDispatch(scope, record.connectorId);
    if (connector === null || !connector.enabled) throw Object.assign(new Error("The ITSM connector is unavailable"), { code: "NOT_FOUND" });
    const current = (await listFindingCases({ ...scope, connectionId: connection.id }))
      .find((candidate) => candidate.id === record.caseId);
    if (current === undefined) throw Object.assign(new Error("The case was not found"), { code: "NOT_FOUND" });
    const ticket = buildOutboundTicket({
      caseId: current.id,
      title: current.title,
      summary: `Finding ${current.findingFingerprint} from snapshot ${current.findingSnapshotId}.`,
      severity: current.findingSeverity,
      priority: current.priority,
      status: current.status === "closed" ? "accepted_risk" : current.status,
    }, connector.connectorType, connector.projectKey);
    const outboundBody = JSON.stringify(ticket.payload);
    let delivered = false;
    let statusCode: number | undefined;
    let deliveryError: string | undefined;
    try {
      const response = await fetch(connector.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sutra-signature": await signOutboundBody(connector.sharedSecret, outboundBody),
        },
        body: outboundBody,
        signal: AbortSignal.timeout(10_000),
      });
      statusCode = response.status;
      delivered = response.ok;
    } catch (caught) {
      deliveryError = caught instanceof Error ? caught.name : "dispatch-error";
    }
    // Deliberately one attempt: durable retries are owned by background_jobs.
    const outcome = delivered ? `delivered (${statusCode})` : statusCode === undefined ? `failed (${deliveryError})` : `rejected (${statusCode})`;
    await addCaseNote({
      ...scope,
      connectionId: connection.id,
      caseId: current.id,
      actorUserId: authenticated.subject.userId,
      note: `ITSM dispatch to '${connector.name}' ${outcome}.`,
    });
    return jsonResponse({
      delivered,
      ...(statusCode === undefined ? { error: deliveryError ?? "dispatch-error" } : { statusCode }),
      payloadPreview: outboundBody.slice(0, 500),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
