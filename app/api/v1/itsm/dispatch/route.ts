import { addCaseNote, listFindingCases } from "../../../../../db/case-repository";
import { ItsmConnectorRepository } from "../../../../../db/itsm-connector-repository";
import { JobQueueRepository } from "../../../../../db/job-queue-repository";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { buildOutboundTicket, signOutboundBody, type ItsmCaseLike } from "../../../../../lib/itsm-sync";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";
import { assertSafeOutboundUrl } from "../../../../../lib/ssrf-guard";

export const dynamic = "force-dynamic";

const CONNECTOR_ID = /^itc_[a-f0-9]{32}$/u;
const CASE_ID = /^case_[a-f0-9]{32}$/u;

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body: unknown = await readBoundedJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw Object.assign(new Error("The ITSM dispatch request is invalid"), { code: "INVALID_INPUT" });
    }
    const record = body as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !["connectorId", "caseId"].includes(key)) ||
      typeof record.connectorId !== "string" || !CONNECTOR_ID.test(record.connectorId) ||
      typeof record.caseId !== "string" || !CASE_ID.test(record.caseId)
    ) throw Object.assign(new Error("The ITSM dispatch request is invalid"), { code: "INVALID_INPUT" });
    const { authenticated, connection, scope } = await requireConnectionScope(request, "connection:manage");
    const repository = new ItsmConnectorRepository();
    const connector = await repository.getForDispatch(scope, record.connectorId);
    if (connector === null || !connector.enabled) throw Object.assign(new Error("The ITSM connector is unavailable"), { code: "NOT_FOUND" });
    const current = (await listFindingCases({ ...scope, connectionId: connection.id }))
      .find((candidate) => candidate.id === record.caseId);
    if (current === undefined) throw Object.assign(new Error("The case was not found"), { code: "NOT_FOUND" });
    const itsmCase: ItsmCaseLike = {
      caseId: current.id,
      title: current.title,
      summary: `Finding ${current.findingFingerprint} from snapshot ${current.findingSnapshotId}.`,
      severity: current.findingSeverity,
      priority: current.priority,
      status: current.status === "closed" ? "accepted_risk" : current.status,
    };
    const ticket = buildOutboundTicket(itsmCase, connector.connectorType, connector.projectKey);
    const outboundBody = JSON.stringify(ticket.payload);
    let delivered = false;
    let statusCode: number | undefined;
    let deliveryError: string | undefined;
    try {
      // Re-check the stored base URL right before egress (defense in depth) and
      // refuse to follow redirects so a 3xx to an internal target cannot bypass
      // the SSRF guard after the first hop.
      const target = assertSafeOutboundUrl(connector.baseUrl);
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sutra-signature": await signOutboundBody(connector.sharedSecret, outboundBody),
        },
        body: outboundBody,
        redirect: "error",
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
    // The immediate attempt above is unchanged and best-effort. If it did not
    // deliver, hand the retry to the durable queue so backoff/dead-letter is
    // owned by background_jobs. A queue failure must never break this response.
    let durableRetryScheduled = false;
    if (!delivered) {
      try {
        await new JobQueueRepository().enqueue({
          orgId: scope.orgId,
          customerId: connection.customerId,
          kind: "itsm-dispatch",
          payload: {
            customerId: connection.customerId,
            connectionId: connection.id,
            connectorId: record.connectorId,
            connectorName: connector.name,
            actorUserId: authenticated.subject.userId,
            itsmCase,
          },
        });
        durableRetryScheduled = true;
      } catch {
        durableRetryScheduled = false;
      }
    }
    return jsonResponse({
      delivered,
      ...(statusCode === undefined ? { error: deliveryError ?? "dispatch-error" } : { statusCode }),
      payloadPreview: outboundBody.slice(0, 500),
      durableRetryScheduled,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
