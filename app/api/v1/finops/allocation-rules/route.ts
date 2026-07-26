import { getLatestConnectionForOrg } from "../../../../../db/pilot-repository";
import { AllocationRuleRepository } from "../../../../../db/allocation-rules-repository";
import type { AllocationRuleInput, AllocationRulePatch } from "../../../../../db/allocation-rules-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const RULE_ID = /^ar_[a-f0-9]{32}$/u;

async function resolveScope(request: Request, capability: "connection:read" | "connection:manage") {
  const authenticated = await requireApiSession(request);
  const connection = await getLatestConnectionForOrg(authenticated.subject.orgId);
  if (connection === null) throw Object.assign(new Error("No cloud connection is configured"), { code: "NOT_FOUND" });
  assertSessionCapability(authenticated, capability, connection.customerId);
  return { authenticated, connection, scope: { orgId: authenticated.subject.orgId, customerId: connection.customerId } };
}

function badRequest(): never {
  throw Object.assign(new Error("The allocation-rule request is invalid"), { code: "INVALID_INPUT" });
}

/** Shape a raw JSON body into a validated match pattern (further checked in the repo). */
function readMatch(value: unknown): AllocationRuleInput["match"] {
  if (typeof value !== "object" || value === null) badRequest();
  const raw = value as Record<string, unknown>;
  const match: { account?: string; service?: string; tagKey?: string; tagValue?: string } = {};
  for (const key of ["account", "service", "tagKey", "tagValue"] as const) {
    const cell = raw[key];
    if (cell === undefined || cell === null) continue;
    if (typeof cell !== "string") badRequest();
    match[key] = cell;
  }
  return match;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope } = await resolveScope(request, "connection:read");
    const repository = new AllocationRuleRepository();
    return jsonResponse({ rules: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) badRequest();
    const { name, priority, match, targetKind, targetValue, enabled } = body as {
      name?: unknown; priority?: unknown; match?: unknown; targetKind?: unknown; targetValue?: unknown; enabled?: unknown;
    };
    if (typeof name !== "string" || typeof targetKind !== "string" || typeof targetValue !== "string") badRequest();
    if (priority !== undefined && typeof priority !== "number") badRequest();
    if (enabled !== undefined && typeof enabled !== "boolean") badRequest();
    const { connection, scope } = await resolveScope(request, "connection:manage");
    const input: AllocationRuleInput = {
      name,
      priority: priority as number | undefined,
      match: readMatch(match),
      targetKind: targetKind as AllocationRuleInput["targetKind"],
      targetValue,
      enabled: enabled as boolean | undefined,
      connectionId: connection.id,
    };
    const repository = new AllocationRuleRepository();
    const saved = await repository.create(scope, input);
    return jsonResponse({ saved, rules: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (!RULE_ID.test(id)) badRequest();
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) badRequest();
    const { name, priority, match, targetKind, targetValue, enabled } = body as {
      name?: unknown; priority?: unknown; match?: unknown; targetKind?: unknown; targetValue?: unknown; enabled?: unknown;
    };
    if (name !== undefined && typeof name !== "string") badRequest();
    if (priority !== undefined && typeof priority !== "number") badRequest();
    if (targetKind !== undefined && typeof targetKind !== "string") badRequest();
    if (targetValue !== undefined && typeof targetValue !== "string") badRequest();
    if (enabled !== undefined && typeof enabled !== "boolean") badRequest();
    const patch: AllocationRulePatch = {
      name: name as string | undefined,
      priority: priority as number | undefined,
      match: match === undefined ? undefined : readMatch(match),
      targetKind: targetKind as AllocationRulePatch["targetKind"],
      targetValue: targetValue as string | undefined,
      enabled: enabled as boolean | undefined,
    };
    const { scope } = await resolveScope(request, "connection:manage");
    const repository = new AllocationRuleRepository();
    const updated = await repository.update(scope, id, patch);
    if (updated === null) throw Object.assign(new Error("Allocation rule not found"), { code: "NOT_FOUND" });
    return jsonResponse({ updated, rules: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (!RULE_ID.test(id)) badRequest();
    const { scope } = await resolveScope(request, "connection:manage");
    const repository = new AllocationRuleRepository();
    const deleted = await repository.delete(scope, id);
    return jsonResponse({ deleted, rules: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}
