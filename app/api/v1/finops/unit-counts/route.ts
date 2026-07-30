import {
  FinopsUnitCountRepository,
  isValidPeriod,
  isValidUnitCount,
  isValidUnitLabel,
} from "../../../../../db/finops-unit-count-repository";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

// Bodies are tiny — a period, a label, and a count. Anything larger is not a
// real unit-count submission.
const MAX_BODY_BYTES = 4 * 1024;

/**
 * Resolve the tenant scope from the explicitly selected connection.
 */
async function resolveScope(request: Request, capability: "connection:read" | "connection:manage") {
  return requireConnectionScope(request, capability);
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
