import {
  addCaseNote,
  assignFindingCase,
  createFindingCase,
  listCaseAssignees,
  listFindingCases,
  prioritizeFindingCase,
  rescheduleFindingCase,
  transitionFindingCase,
} from "../../../../db/case-repository";
import { getConnection } from "../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../lib/aws-pilot-security";
import {
  parseCaseDueAt,
  parseCaseNote,
  parseCasePriority,
  parseCaseStatus,
} from "../../../../lib/case-management";
import { errorResponse, jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CASE_ID = /^case_[a-f0-9]{32}$/u;
const FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._:@/#+=-]{0,127}$/u;
const MEMBERSHIP_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;

function invalid(message = "The case request is invalid"): never {
  throw Object.assign(new Error(message), { code: "INVALID_INPUT" });
}

function requiredString(value: unknown, pattern: RegExp, message: string): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(message);
  return value;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || required.some((key) => !(key in record))) invalid("The case request contains unsupported or missing fields");
  return record;
}

function nullableMembership(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredString(value, MEMBERSHIP_ID, "The case assignee is invalid");
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) invalid();
    const connectionId = requiredString(url.searchParams.get("connectionId"), CONNECTION_ID, "The connection identifier is invalid");
    const authenticated = await requireApiSession(request);
    const connection = await getConnection(connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const [cases, assignees] = await Promise.all([
      listFindingCases({
        orgId: authenticated.subject.orgId,
        customerId: connection.customerId,
        connectionId,
      }),
      listCaseAssignees({
        orgId: authenticated.subject.orgId,
        customerId: connection.customerId,
      }),
    ]);
    return jsonResponse({ connection, cases, assignees });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const authenticated = await requireApiSession(request);
    const raw = await readBoundedJson(request);
    const base = exactRecord(raw, ["operation", "connectionId"], [
      "caseId", "fingerprint", "priority", "assigneeMembershipId", "dueAt", "status", "note",
    ]);
    const operation = requiredString(base.operation, /^(?:create|note|transition|assign|prioritize|reschedule)$/u, "The case operation is invalid");
    const connectionId = requiredString(base.connectionId, CONNECTION_ID, "The connection identifier is invalid");
    const connection = await getConnection(connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "finding:manage", connection.customerId);
    const scope = {
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId,
      actorUserId: authenticated.subject.userId,
    };
    let result;
    if (operation === "create") {
      exactRecord(raw, ["operation", "connectionId", "fingerprint", "priority"], ["assigneeMembershipId", "dueAt"]);
      const priority = parseCasePriority(base.priority);
      result = await createFindingCase({
        ...scope,
        fingerprint: requiredString(base.fingerprint, FINGERPRINT, "The finding fingerprint is invalid"),
        priority,
        assigneeMembershipId: nullableMembership(base.assigneeMembershipId),
        dueAt: base.dueAt === undefined || base.dueAt === null || base.dueAt === ""
          ? null
          : parseCaseDueAt(base.dueAt, Date.now()),
      });
    } else {
      const caseId = requiredString(base.caseId, CASE_ID, "The case identifier is invalid");
      if (operation === "note") {
        exactRecord(raw, ["operation", "connectionId", "caseId", "note"]);
        result = await addCaseNote({ ...scope, caseId, note: parseCaseNote(base.note) });
      } else if (operation === "transition") {
        exactRecord(raw, ["operation", "connectionId", "caseId", "status"]);
        result = await transitionFindingCase({ ...scope, caseId, status: parseCaseStatus(base.status) });
      } else if (operation === "assign") {
        exactRecord(raw, ["operation", "connectionId", "caseId", "assigneeMembershipId"]);
        result = await assignFindingCase({ ...scope, caseId, assigneeMembershipId: nullableMembership(base.assigneeMembershipId) });
      } else if (operation === "prioritize") {
        exactRecord(raw, ["operation", "connectionId", "caseId", "priority"]);
        result = await prioritizeFindingCase({ ...scope, caseId, priority: parseCasePriority(base.priority) });
      } else {
        exactRecord(raw, ["operation", "connectionId", "caseId", "dueAt"]);
        result = await rescheduleFindingCase({ ...scope, caseId, dueAt: parseCaseDueAt(base.dueAt, Date.now()) });
      }
    }
    return jsonResponse({ case: result }, { status: operation === "create" ? 201 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
