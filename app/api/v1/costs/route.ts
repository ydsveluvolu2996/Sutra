import { appendAuditEvent, getConnection, getStoredConnectionSecret, LOCAL_ORG_ID } from "../../../../db/pilot-repository";
import { getLatestCostSnapshot, persistCostSnapshot } from "../../../../db/cost-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../lib/aws-pilot-security";
import {
  errorResponse,
  getCollectorHealth,
  jsonResponse,
  runCollectorCostCollection,
} from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

function parseConnectionId(value: unknown): string {
  if (typeof value !== "string" || !CONNECTION_ID.test(value)) {
    throw Object.assign(new Error("The cost request is invalid"), { code: "INVALID_INPUT" });
  }
  return value;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) {
      throw Object.assign(new Error("The cost request is invalid"), { code: "INVALID_INPUT" });
    }
    const connectionId = parseConnectionId(url.searchParams.get("connectionId"));
    const authenticated = await requireApiSession(request);
    const connection = await getConnection(connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const snapshot = await getLatestCostSnapshot({
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId,
    });
    return jsonResponse({ connection, snapshot });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const authenticated = await requireApiSession(request);
    assertSameOrigin(request);
    const body = await readBoundedJson(request);
    if (
      typeof body !== "object" || body === null || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !("connectionId" in body)
    ) throw Object.assign(new Error("The cost request is invalid"), { code: "INVALID_INPUT" });
    const connectionId = parseConnectionId((body as { connectionId?: unknown }).connectionId);
    const stored = await getStoredConnectionSecret(connectionId);
    assertSessionCapability(authenticated, "sync:run", stored.customerId);
    if (stored.status !== "active") {
      throw Object.assign(new Error("Activate the AWS connection before collecting cost evidence"), { code: "INVALID_STATE" });
    }
    const health = await getCollectorHealth(stored.partition);
    if (health.mode !== "live") {
      throw Object.assign(new Error("Live AWS mode is required to collect Cost Explorer evidence"), { code: "INVALID_STATE" });
    }
    const jobId = `cost_${crypto.randomUUID().replaceAll("-", "")}`;
    const payload = await runCollectorCostCollection({
      tenantId: LOCAL_ORG_ID,
      connectionId,
      jobId,
      accountId: stored.accountId,
      partition: stored.partition,
    });
    const snapshot = await persistCostSnapshot({
      orgId: authenticated.subject.orgId,
      customerId: stored.customerId,
      connectionId,
      payload,
    });
    await appendAuditEvent({
      actorId: authenticated.subject.userId,
      action: "aws.costs.collected",
      targetType: "aws_connection",
      targetId: connectionId,
      customerId: stored.customerId,
      outcome: "allowed",
      requestId: `aws.costs.collected:${snapshot.id}`,
      metadata: {
        costSnapshotId: snapshot.id,
        status: payload.status,
        payloadSha256: snapshot.payloadSha256,
        periodStart: payload.periodStart,
        periodEnd: payload.periodEnd,
      },
    });
    return jsonResponse({ snapshot }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
