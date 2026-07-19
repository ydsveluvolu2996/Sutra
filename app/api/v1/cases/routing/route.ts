import { CaseRoutingRepository, type CaseRoutingTenantScope } from "../../../../../db/case-routing-repository";
import { listFindingCases } from "../../../../../db/case-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { routeCases } from "../../../../../lib/case-routing";
import { caseToRoutingCase, storedRuleToRoutingRule } from "../../../../../lib/case-routing-inputs";
import type { Capability } from "../../../../../lib/auth-policy";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const RULE_ID = /^croute_[a-f0-9]{32}$/u;

function invalid(message = "The case routing request is invalid"): never {
  throw Object.assign(new Error(message), { code: "INVALID_INPUT", status: 400 });
}

function connectionIdFrom(value: unknown): string {
  if (typeof value !== "string" || !CONNECTION_ID.test(value)) invalid("The connection identifier is invalid");
  return value;
}

async function scopedConnection(request: Request, connectionId: string, capability: Capability) {
  const authenticated = await requireApiSession(request);
  const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
  if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
  assertSessionCapability(authenticated, capability, connection.customerId);
  const scope: CaseRoutingTenantScope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
  return { authenticated, connection, scope };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) invalid();
    const connectionId = connectionIdFrom(url.searchParams.get("connectionId"));
    const { scope } = await scopedConnection(request, connectionId, "connection:read");
    const rules = await new CaseRoutingRepository().list(scope);
    // Preview only: route non-closed cases through the rules; never mutate assignees.
    const cases = (await listFindingCases({ orgId: scope.orgId, customerId: scope.customerId, connectionId }))
      .filter((item) => item.status !== "closed");
    const preview = routeCases(cases.map(caseToRoutingCase), rules.map(storedRuleToRoutingRule));
    return jsonResponse({ rules, preview, openCases: cases.length });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readBoundedJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) invalid();
    const record = body as Record<string, unknown>;
    const allowed = new Set(["connectionId", "priority", "matchSeverity", "matchCustomerId", "routeAssignee", "routeTeam", "routeDestination"]);
    if (Object.keys(record).some((key) => !allowed.has(key))) invalid("The routing rule contains unsupported fields");
    const connectionId = connectionIdFrom(record.connectionId);
    if (typeof record.priority !== "number") invalid("A numeric rule priority is required");
    const matchSeverity = Array.isArray(record.matchSeverity)
      ? record.matchSeverity.filter((value): value is string => typeof value === "string")
      : undefined;
    const asText = (value: unknown): string | null => (typeof value === "string" ? value : null);

    const { scope } = await scopedConnection(request, connectionId, "finding:manage");
    const rule = await new CaseRoutingRepository().create(scope, {
      priority: record.priority,
      matchSeverity,
      matchCustomerId: asText(record.matchCustomerId),
      routeAssignee: asText(record.routeAssignee),
      routeTeam: asText(record.routeTeam),
      routeDestination: asText(record.routeDestination),
    });
    return jsonResponse({ rule }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !["connectionId", "ruleId"].includes(key))) invalid();
    const connectionId = connectionIdFrom(url.searchParams.get("connectionId"));
    const ruleId = url.searchParams.get("ruleId");
    if (ruleId === null || !RULE_ID.test(ruleId)) invalid("The routing rule identifier is invalid");
    const { scope } = await scopedConnection(request, connectionId, "finding:manage");
    const removed = await new CaseRoutingRepository().remove(scope, ruleId);
    if (!removed) throw Object.assign(new Error("Routing rule not found"), { code: "NOT_FOUND", status: 404 });
    return jsonResponse({ removed: true, ruleId });
  } catch (error) {
    return errorResponse(error);
  }
}
