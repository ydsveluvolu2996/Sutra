import { getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { CmdbWorkspaceRepository } from "../../../../../db/cmdb-workspace-repository";
import { CmdbCustomAssetRepository } from "../../../../../db/cmdb-custom-asset-repository";
import { toCmdbResource } from "../../../../../lib/cmdb-custom-assets";
import { buildReport, toCsv, validateReportDefinition } from "../../../../../lib/report-builder";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";
import type { CmdbQueryResource } from "../../../../../lib/cmdb-query";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;

/**
 * Resolve the tenant scope from the explicitly selected connection. Rows are
 * always loaded live and tenant-scoped at run time, so a report
 * definition can never surface stale or cross-tenant data. Running a report is a
 * read; it is gated on connection:read.
 */
async function resolveContext(request: Request) {
  return requireConnectionScope(request, "connection:read");
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
      // Imported custom/external assets are first-class CMDB items — include them
      // so reports over the CMDB dataset cover non-cloud assets too.
      const customAssets = (await new CmdbCustomAssetRepository().list(scope)).map((asset) => toCmdbResource(asset));
      report = buildReport(definition, [...resources, ...customAssets]);
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
