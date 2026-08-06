import { isCollectableAwsSourceKind } from "../../../../lib/aws-connection-source";
import {
  getSecurityEventsWorkspace,
  persistSecurityEventCollection,
  securityEventCollectionWindow,
  updateSecurityDetectionStatus,
} from "../../../../db/security-event-repository";
import { CURRENT_PILOT_PERMISSION_PACK, getConnectionForOrg } from "../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../lib/aws-pilot-security";
import {
  errorResponse,
  getCollectorHealth,
  jsonResponse,
  runCollectorSecurityEventCollection,
} from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const DETECTION_ID = /^sdet_[a-f0-9]{48}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+$/u;
const EVENT_NAME = /^[A-Za-z0-9._-]{1,128}$/u;

function connectionId(value: unknown): string {
  if (typeof value !== "string" || !CONNECTION_ID.test(value)) invalid();
  return value;
}

function invalid(): never {
  throw Object.assign(new Error("The security-event request is invalid"), { code: "INVALID_INPUT" });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const allowed = new Set(["connectionId", "q", "region", "eventName", "limit"]);
    if (
      [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
      [...allowed].some((key) => url.searchParams.getAll(key).length > 1)
    ) invalid();
    const selectedConnectionId = connectionId(url.searchParams.get("connectionId"));
    const query = url.searchParams.get("q")?.trim() || undefined;
    const region = url.searchParams.get("region") || undefined;
    const eventName = url.searchParams.get("eventName") || undefined;
    const rawLimit = url.searchParams.get("limit") ?? "100";
    if (
      (query !== undefined && (query.length > 100 || /[\u0000-\u001f\u007f]/u.test(query))) ||
      (region !== undefined && !REGION.test(region)) ||
      (eventName !== undefined && !EVENT_NAME.test(eventName)) ||
      !/^\d{1,3}$/u.test(rawLimit)
    ) invalid();
    const limit = Number(rawLimit);
    if (limit < 1 || limit > 200) invalid();
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, selectedConnectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const workspace = await getSecurityEventsWorkspace({
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: selectedConnectionId,
      ...(query === undefined ? {} : { search: query }),
      ...(region === undefined ? {} : { region }),
      ...(eventName === undefined ? {} : { eventName }),
      limit,
    });
    return jsonResponse({ connection, workspace });
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
    ) invalid();
    const selectedConnectionId = connectionId((body as { connectionId?: unknown }).connectionId);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, selectedConnectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "sync:run", connection.customerId);
    if (!isCollectableAwsSourceKind(connection.sourceKind) || connection.status !== "active") {
      throw Object.assign(new Error("Activate a live AWS trust connection before collecting security events"), { code: "INVALID_STATE" });
    }
    if (connection.permissionPackVersion !== CURRENT_PILOT_PERMISSION_PACK) {
      throw Object.assign(new Error("Revalidate the current AWS permission pack before collecting security events"), { code: "INVALID_STATE" });
    }
    const health = await getCollectorHealth(connection.partition);
    if (health.mode !== "live") {
      throw Object.assign(new Error("Live AWS mode is required for CloudTrail security-event collection"), { code: "INVALID_STATE" });
    }
    const window = await securityEventCollectionWindow({
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: selectedConnectionId,
    });
    const collected = await runCollectorSecurityEventCollection({
      tenantId: authenticated.subject.orgId,
      connectionId: selectedConnectionId,
      jobId: `sevt_${crypto.randomUUID().replaceAll("-", "")}`,
      accountId: connection.awsAccountId,
      partition: connection.partition,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
    });
    const continuityLimitations = [
      ...(window.basis === "INCOMPLETE_RETRY" ? ["RETRYING_INCOMPLETE_WINDOW"] : []),
      ...(window.basis === "COMPLETE_CHECKPOINT_OVERLAP" ? ["CHECKPOINT_OVERLAP_APPLIED"] : []),
      ...(window.gapTruncated ? ["CHECKPOINT_GAP_TRUNCATED_TO_24_HOURS"] : []),
    ];
    const payload = {
      ...collected,
      limitations: [...new Set([...collected.limitations, ...continuityLimitations])],
    };
    const run = await persistSecurityEventCollection({
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: selectedConnectionId,
      actorId: authenticated.subject.userId,
      windowBasis: window.basis,
      overlapMinutes: window.overlapMinutes,
      gapTruncated: window.gapTruncated,
      payload,
    });
    const workspace = await getSecurityEventsWorkspace({
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: selectedConnectionId,
      limit: 100,
    });
    return jsonResponse({ run, workspace }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const authenticated = await requireApiSession(request);
    assertSameOrigin(request);
    const body = await readBoundedJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) invalid();
    const record = body as Record<string, unknown>;
    const allowed = new Set(["connectionId", "detectionId", "status", "note"]);
    if (
      Object.keys(record).some((key) => !allowed.has(key)) ||
      !["connectionId", "detectionId", "status"].every((key) => key in record)
    ) invalid();
    const selectedConnectionId = connectionId(record.connectionId);
    if (typeof record.detectionId !== "string" || !DETECTION_ID.test(record.detectionId)) invalid();
    if (record.status !== "open" && record.status !== "acknowledged") invalid();
    const note = record.note === undefined || record.note === null
      ? null
      : typeof record.note === "string" ? record.note.trim() : invalid();
    if (note !== null && (note.length > 500 || /[\u0000-\u001f\u007f]/u.test(note))) invalid();
    const connection = await getConnectionForOrg(authenticated.subject.orgId, selectedConnectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "finding:manage", connection.customerId);
    const detection = await updateSecurityDetectionStatus({
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: selectedConnectionId,
      detectionId: record.detectionId,
      status: record.status,
      note,
      actorId: authenticated.subject.userId,
    });
    return jsonResponse({ detection });
  } catch (error) {
    return errorResponse(error);
  }
}
