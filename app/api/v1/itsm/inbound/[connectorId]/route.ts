import { addCaseNote, listFindingCases, transitionFindingCase } from "../../../../../../db/case-repository";
import { ItsmConnectorRepository } from "../../../../../../db/itsm-connector-repository";
import { getLatestConnectionForOrg } from "../../../../../../db/pilot-repository";
import { decideInboundTransition, verifyInboundSignature } from "../../../../../../lib/itsm-sync";
import { errorResponse, jsonResponse } from "../../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTOR_ID = /^itc_[a-f0-9]{32}$/u;
const CASE_ID = /^case_[a-f0-9]{32}$/u;
const MAX_BODY_BYTES = 64 * 1024;

function unauthorized(): Response {
  return jsonResponse({ error: { code: "UNAUTHORIZED", message: "The ITSM webhook signature is invalid" } }, { status: 401 });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ connectorId: string }> },
): Promise<Response> {
  try {
    const { connectorId } = await context.params;
    if (!CONNECTOR_ID.test(connectorId)) return unauthorized();
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      throw Object.assign(new Error("The webhook payload is too large"), { code: "INVALID_INPUT" });
    }
    const repository = new ItsmConnectorRepository();
    const connector = await repository.getForInbound(connectorId);
    if (
      connector === null ||
      !connector.enabled ||
      !(await verifyInboundSignature(connector.sharedSecret, rawBody, request.headers.get("x-sutra-signature")))
    ) return unauthorized();

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw Object.assign(new Error("The webhook payload is invalid"), { code: "INVALID_INPUT" });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw Object.assign(new Error("The webhook payload is invalid"), { code: "INVALID_INPUT" });
    }
    const record = body as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !["caseId", "remoteStatus", "remoteUpdatedAt"].includes(key)) ||
      typeof record.caseId !== "string" || !CASE_ID.test(record.caseId) ||
      typeof record.remoteStatus !== "string" || record.remoteStatus.length < 1 || record.remoteStatus.length > 128 ||
      typeof record.remoteUpdatedAt !== "string" || record.remoteUpdatedAt.length > 40
    ) throw Object.assign(new Error("The webhook payload is invalid"), { code: "INVALID_INPUT" });
    const remoteUpdatedAtMs = Date.parse(record.remoteUpdatedAt);
    if (!Number.isFinite(remoteUpdatedAtMs) || new Date(remoteUpdatedAtMs).toISOString() !== record.remoteUpdatedAt) {
      throw Object.assign(new Error("The remote timestamp is invalid"), { code: "INVALID_INPUT" });
    }
    const connection = await getLatestConnectionForOrg(connector.orgId);
    if (connection === null || connection.customerId !== connector.customerId) {
      throw Object.assign(new Error("The connector scope is not available"), { code: "NOT_FOUND" });
    }
    const current = (await listFindingCases({
      orgId: connector.orgId,
      customerId: connector.customerId,
      connectionId: connection.id,
    })).find((candidate) => candidate.id === record.caseId);
    if (current === undefined) throw Object.assign(new Error("The case was not found"), { code: "NOT_FOUND" });
    const externalCurrent = current.status === "closed" ? "accepted_risk" : current.status;
    const decision = decideInboundTransition({
      connectorType: connector.connectorType,
      connectorName: connector.name,
      currentStatus: externalCurrent,
      remoteStatus: record.remoteStatus,
      remoteUpdatedAtMs,
      lastLocalChangeMs: Date.parse(current.updatedAt),
    });
    if (decision.kind !== "apply") {
      return jsonResponse({ decision: decision.kind, ...(decision.kind === "skip-unmapped" ? { remoteStatus: decision.remoteStatus } : {}) });
    }
    const internalStatus = decision.status === "accepted_risk" ? "closed" : decision.status;
    await transitionFindingCase({
      orgId: connector.orgId,
      customerId: connector.customerId,
      connectionId: connection.id,
      caseId: current.id,
      actorUserId: connector.createdBy,
      status: internalStatus,
      now: remoteUpdatedAtMs,
    });
    await addCaseNote({
      orgId: connector.orgId,
      customerId: connector.customerId,
      connectionId: connection.id,
      caseId: current.id,
      actorUserId: connector.createdBy,
      note: decision.provenanceNote,
      now: remoteUpdatedAtMs,
    });
    return jsonResponse({ decision: "applied", status: decision.status });
  } catch (error) {
    return errorResponse(error);
  }
}
