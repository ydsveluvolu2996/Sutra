import { addCaseNote, listFindingCases, transitionFindingCase } from "../../../../../../db/case-repository";
import { ItsmConnectorRepository } from "../../../../../../db/itsm-connector-repository";
import { listConnectionsForOrg } from "../../../../../../db/pilot-repository";
import { decideInboundTransition, verifyInboundSignature } from "../../../../../../lib/itsm-sync";
import { errorResponse, jsonResponse } from "../../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTOR_ID = /^itc_[a-f0-9]{32}$/u;
const CASE_ID = /^case_[a-f0-9]{32}$/u;
const MAX_BODY_BYTES = 64 * 1024;

function unauthorized(): Response {
  return jsonResponse({ error: { code: "UNAUTHORIZED", message: "The ITSM webhook signature is invalid" } }, { status: 401 });
}

function payloadTooLarge(): Error {
  return Object.assign(new Error("The webhook payload is too large"), { code: "INVALID_INPUT" });
}

/**
 * Reads the raw request body while streaming, aborting the moment the
 * accumulated size exceeds MAX_BODY_BYTES. This endpoint is unauthenticated
 * and runs before HMAC verification, so the read itself must be bounded — a
 * false or omitted Content-Length must not let an attacker force us to buffer
 * an unbounded body. The raw bytes are returned as a UTF-8 string so that
 * downstream signature verification (which needs the exact bytes) and JSON
 * parsing are unchanged from the previous `await request.text()` behavior.
 */
async function readBoundedRawBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > MAX_BODY_BYTES) {
    throw payloadTooLarge();
  }
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw payloadTooLarge();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(combined);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ connectorId: string }> },
): Promise<Response> {
  try {
    const { connectorId } = await context.params;
    if (!CONNECTOR_ID.test(connectorId)) return unauthorized();
    const rawBody = await readBoundedRawBody(request);
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
    const customerConnections = (await listConnectionsForOrg(connector.orgId))
      .filter((candidate) => candidate.customerId === connector.customerId);
    if (customerConnections.length === 0) {
      throw Object.assign(new Error("The connector scope is not available"), { code: "NOT_FOUND" });
    }
    let matched:
      | {
          readonly connection: (typeof customerConnections)[number];
          readonly current: Awaited<ReturnType<typeof listFindingCases>>[number];
        }
      | undefined;
    for (const connection of customerConnections) {
      const current = (await listFindingCases({
        orgId: connector.orgId,
        customerId: connector.customerId,
        connectionId: connection.id,
      })).find((candidate) => candidate.id === record.caseId);
      if (current !== undefined) {
        matched = { connection, current };
        break;
      }
    }
    if (matched === undefined) throw Object.assign(new Error("The case was not found"), { code: "NOT_FOUND" });
    const { connection, current } = matched;
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
