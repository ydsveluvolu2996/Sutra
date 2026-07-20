import { getLatestConnectionForOrg } from "../../../../../db/pilot-repository";
import {
  FinopsUnitCountRepository,
  isValidPeriod,
  isValidUnitCount,
  isValidUnitLabel,
} from "../../../../../db/finops-unit-count-repository";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

// Bodies are tiny — a period, a label, and a count. Anything larger is not a
// real unit-count submission.
const MAX_BODY_BYTES = 4 * 1024;

/**
 * Resolve the tenant scope from the SESSION, never the caller. The customer is
 * derived from the org's latest cloud connection (mirroring the budgets route),
 * and the capability is checked against that resolved customer so scoping is
 * enforced server-side rather than trusted from the request.
 */
async function resolveScope(request: Request, capability: "connection:read" | "connection:manage") {
  const authenticated = await requireApiSession(request);
  const connection = await getLatestConnectionForOrg(authenticated.subject.orgId);
  if (connection === null) throw Object.assign(new Error("No cloud connection is configured"), { code: "NOT_FOUND" });
  assertSessionCapability(authenticated, capability, connection.customerId);
  return { authenticated, scope: { orgId: authenticated.subject.orgId, customerId: connection.customerId } };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const period = url.searchParams.get("period");
    if (period !== null && !isValidPeriod(period)) {
      throw Object.assign(new Error("The unit-count request is invalid"), { code: "INVALID_INPUT" });
    }
    const { scope } = await resolveScope(request, "connection:read");
    const repository = new FinopsUnitCountRepository();
    const unitCounts = await repository.list(scope, period === null ? {} : { period });
    return jsonResponse({ unitCounts });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readBoundedJson(request, MAX_BODY_BYTES);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw Object.assign(new Error("The unit-count request is invalid"), { code: "INVALID_INPUT" });
    }
    const { period, unitLabel, count } = body as { period?: unknown; unitLabel?: unknown; count?: unknown };
    if (
      typeof period !== "string" || !isValidPeriod(period) ||
      typeof unitLabel !== "string" || !isValidUnitLabel(unitLabel) ||
      typeof count !== "number" || !isValidUnitCount(count)
    ) {
      throw Object.assign(new Error("The unit-count request is invalid"), { code: "INVALID_INPUT" });
    }
    const { scope } = await resolveScope(request, "connection:manage");
    const repository = new FinopsUnitCountRepository();
    const saved = await repository.upsert(scope, { period, unitLabel, count });
    return jsonResponse({ saved, unitCounts: await repository.list(scope, {}) });
  } catch (error) {
    return errorResponse(error);
  }
}
