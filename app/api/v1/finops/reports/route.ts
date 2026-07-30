import { FinopsScheduledReportRepository } from "../../../../../db/finops-scheduled-report-repository";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

// Bodies are small — a name, cadence, and destination. Anything larger is not a
// real schedule definition.
const MAX_BODY_BYTES = 8 * 1024;

const REPORT_ID = /^fsr_[a-f0-9]{32}$/u;
const REPORT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._:/+-]{0,79}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

function invalid(): never {
  throw Object.assign(new Error("The scheduled-report request is invalid"), { code: "INVALID_INPUT" });
}

/** Resolve the tenant from the explicitly selected connection. */
async function resolveTenantScope(request: Request, capability: "connection:read" | "connection:manage") {
  return requireConnectionScope(request, capability);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope } = await resolveTenantScope(request, "connection:read");
    const repository = new FinopsScheduledReportRepository();
    return jsonResponse({ reports: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readBoundedJson(request, MAX_BODY_BYTES);
    if (typeof body !== "object" || body === null || Array.isArray(body)) invalid();
    const record = body as Record<string, unknown>;

    // Enable/disable action leaves the schedule row in place.
    if (record.action === "setEnabled") {
      const { id, enabled } = record;
      if (typeof id !== "string" || !REPORT_ID.test(id) || typeof enabled !== "boolean") invalid();
      const { scope } = await resolveTenantScope(request, "connection:manage");
      const repository = new FinopsScheduledReportRepository();
      const updated = await repository.setEnabled(scope, id, enabled);
      return jsonResponse({ updated, reports: await repository.list(scope) });
    }

    const { name, connectionId, cadence, deliveryKind, deliveryTarget, enabled } = record as {
      name?: unknown; connectionId?: unknown; cadence?: unknown;
      deliveryKind?: unknown; deliveryTarget?: unknown; enabled?: unknown;
    };
    if (
      typeof name !== "string" || !REPORT_NAME.test(name) ||
      typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId) ||
      (cadence !== "weekly" && cadence !== "monthly") ||
      (deliveryKind !== "webhook" && deliveryKind !== "email") ||
      typeof deliveryTarget !== "string" || deliveryTarget.length === 0 || deliveryTarget.length > 2_048 ||
      (enabled !== undefined && typeof enabled !== "boolean")
    ) invalid();
    const { authenticated, connection, scope } = await resolveTenantScope(request, "connection:manage");
    if (connection.id !== connectionId) invalid();
    const repository = new FinopsScheduledReportRepository();
    // The repository performs the authoritative SSRF/email validation of the
    // destination and rejects an unsafe target.
    const saved = await repository.save(
      scope,
      { name, connectionId, cadence, deliveryKind, deliveryTarget, enabled: enabled as boolean | undefined },
      authenticated.subject.userId,
    );
    return jsonResponse({ saved, reports: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (!REPORT_ID.test(id)) invalid();
    const { scope } = await resolveTenantScope(request, "connection:manage");
    const repository = new FinopsScheduledReportRepository();
    const deleted = await repository.delete(scope, id);
    return jsonResponse({ deleted, reports: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}
