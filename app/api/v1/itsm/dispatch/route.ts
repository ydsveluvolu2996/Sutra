import { addCaseNote, listFindingCases } from "../../../../../db/case-repository";
import { ItsmConnectorRepository } from "../../../../../db/itsm-connector-repository";
import { JobQueueRepository } from "../../../../../db/job-queue-repository";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { deliverItsmTicket } from "../../../../../lib/itsm-delivery";
import type { ItsmCaseLike } from "../../../../../lib/itsm-sync";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

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
    const delivery = await deliverItsmTicket({
      connector: {
        baseUrl: connector.baseUrl,
        sharedSecret: connector.sharedSecret,
        connectorType: connector.connectorType,
        projectKey: connector.projectKey,
      },
      itsmCase,
    });
    const {
      delivered,
      statusCode,
      error: deliveryError,
      payloadPreview,
    } = delivery;
    if (delivered) {
      await repository.recordOutboundSuccess(scope, connector.id, connector.updatedAt);
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
      payloadPreview,
      durableRetryScheduled,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
