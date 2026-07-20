import { getLatestConnectionForOrg, getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { CmdbWorkspaceRepository } from "../../../../../db/cmdb-workspace-repository";
import { buildReport, toCsv, validateReportDefinition } from "../../../../../lib/report-builder";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";
import type { CmdbQueryResource } from "../../../../../lib/cmdb-query";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;

/**
 * Resolve the tenant scope AND the active connection from the SESSION, never the
 * caller. Rows are always loaded live and tenant-scoped at run time, so a report
 * definition can never surface stale or cross-tenant data. Running a report is a
 * read; it is gated on connection:read.
 */
async function resolveContext(request: Request) {
  const authenticated = await requireApiSession(request);
  const connection = await getLatestConnectionForOrg(authenticated.subject.orgId);
  if (connection === null) throw Object.assign(new Error("No cloud connection is configured"), { code: "NOT_FOUND" });
  assertSessionCapability(authenticated, "connection:read", connection.customerId);
  return { authenticated, connection, scope: { orgId: authenticated.subject.orgId, customerId: connection.customerId } };
}

function wantsCsv(request: Request, body: Record<string, unknown>): boolean {
  if (body.format === "csv") return true;
  return new URL(request.url).searchParams.get("format") === "csv";
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readBoundedJson(request, MAX_BODY_BYTES);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw Object.assign(new Error("The report request is invalid"), { code: "INVALID_INPUT" });
    }
    const record = body as Record<string, unknown>;
    const validation = validateReportDefinition(record.definition);
    if (validation.definition === null) {
      throw Object.assign(new Error(`The report definition is invalid: ${validation.errors.join("; ")}`), { code: "INVALID_INPUT" });
    }
    const definition = validation.definition;

    const { connection, scope } = await resolveContext(request);

    let report;
    if (definition.dataset === "cmdb-resources") {
      const resources: readonly CmdbQueryResource[] = await new CmdbWorkspaceRepository().resourcesForQuery(scope, connection.id);
      report = buildReport(definition, resources);
    } else {
      const state = await getPilotStateForOrg(scope.orgId, connection.id);
      report = buildReport(definition, state.findings as readonly unknown[] as readonly Record<string, unknown>[]);
    }

    if (wantsCsv(request, record)) {
      const csv = toCsv(report.columns, report.rows);
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="report.csv"',
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }

    return jsonResponse({ report });
  } catch (error) {
    return errorResponse(error);
  }
}
