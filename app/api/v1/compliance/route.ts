import { getConnectionForOrg, getPilotStateForOrg } from "../../../../db/pilot-repository";
import { listComplianceExceptions } from "../../../../db/compliance-exception-repository";
import { assertSessionCapability } from "../../../../lib/api-auth";
import { buildComplianceReport } from "../../../../lib/compliance-report";
import { canonicalJson } from "../../../../lib/canonical-json";
import { safeCsvCell } from "../../../../lib/safe-csv";
import type { ComplianceAssessmentWithExceptions } from "../../../../lib/compliance-exception-types";
import {
  errorResponse,
  jsonResponse,
  requirePilotActor,
} from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

type ComplianceResponseFormat = "view" | "json" | "csv";

function complianceCsv(
  assessment: ComplianceAssessmentWithExceptions,
  reportSha256: string,
): string {
  const header = [
    "report_sha256",
    "assessment_id",
    "catalog_key",
    "catalog_version",
    "account_id",
    "connection_id",
    "customer_id",
    "snapshot_id",
    "snapshot_sha256",
    "snapshot_collected_at",
    "control_key",
    "control_version",
    "title",
    "service",
    "scope",
    "severity",
    "status",
    "reason",
    "applicable_resource_count",
    "coverage",
    "matching_findings",
    "approved_exception_ids",
    "exception_expiries",
    "compensating_controls",
    "nist_csf_2_categories",
    "remediation",
    "limitation",
  ];
  const rows = assessment.results.map((result) => [
    reportSha256,
    assessment.assessmentId,
    assessment.catalog.key,
    assessment.catalog.version,
    assessment.provenance.awsAccountId,
    assessment.provenance.connectionId,
    assessment.provenance.customerId,
    assessment.provenance.snapshotId,
    assessment.provenance.snapshotSha256,
    assessment.provenance.snapshotCollectedAt,
    result.controlKey,
    result.controlVersion,
    result.title,
    result.service,
    result.scope,
    result.severity,
    result.status,
    result.reason,
    result.evidence.applicableResourceCount,
    result.evidence.coverage
      .map((item) => `${item.collectorKey}:${item.conclusion}`)
      .join(";"),
    result.evidence.matchingFindings
      .map((finding) => finding.fingerprint)
      .join(";"),
    result.approvedExceptions.map((exception) => exception.exceptionId).join(";"),
    result.approvedExceptions.map((exception) => exception.expiresAt).join(";"),
    result.approvedExceptions.map((exception) => exception.compensatingControl).join(";"),
    result.frameworkMappings
      .flatMap((mapping) => mapping.categories)
      .join(";"),
    result.remediation,
    result.limitation,
  ]);
  return `${header.map(safeCsvCell).join(",")}\r\n${rows
    .map((row) => row.map(safeCsvCell).join(","))
    .join("\r\n")}\r\n`;
}

function parseRequest(url: URL): {
  readonly connectionId: string | null;
  readonly format: ComplianceResponseFormat;
} {
  const connectionId = url.searchParams.get("connectionId");
  const format = url.searchParams.get("format") ?? "view";
  if (
    [...url.searchParams.keys()].some(
      (key) => key !== "connectionId" && key !== "format",
    ) ||
    (connectionId !== null && !/^conn_[a-f0-9]{32}$/u.test(connectionId)) ||
    (format !== "view" && format !== "json" && format !== "csv")
  ) {
    throw Object.assign(new Error("The compliance report request is invalid"), {
      code: "INVALID_INPUT",
    });
  }
  return { connectionId, format };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    const { connectionId, format } = parseRequest(new URL(request.url));
    if (connectionId !== null) {
      const connection = await getConnectionForOrg(actor.orgId, connectionId);
      if (connection === null) {
        throw Object.assign(new Error("Cloud connection not found"), {
          code: "NOT_FOUND",
        });
      }
      assertSessionCapability(
        actor.authenticated,
        format === "view" ? "connection:read" : "export:read",
        connection.customerId,
      );
    }

    const state = await getPilotStateForOrg(actor.orgId, connectionId ?? undefined);
    if (state.connection !== null) {
      assertSessionCapability(
        actor.authenticated,
        format === "view" ? "connection:read" : "export:read",
        state.connection.customerId,
      );
    }
    const exceptionRecords = state.connection === null ? [] : await listComplianceExceptions({
      orgId: actor.orgId,
      customerId: state.connection.customerId,
      connectionId: state.connection.id,
    });
    const { reportSha256, ...reportCore } = await buildComplianceReport(state, exceptionRecords);
    const { assessment } = reportCore;
    if (format === "view") {
      return jsonResponse({ ...reportCore, reportSha256 });
    }

    const accountId = assessment.provenance.awsAccountId ?? "unscoped";
    const snapshotId = assessment.provenance.snapshotId ?? "no-snapshot";
    const filename = `sutra-compliance-${accountId}-${snapshotId}`;
    if (format === "json") {
      return new Response(canonicalJson({ ...reportCore, reportSha256 }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${filename}.json"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    return new Response(complianceCsv(assessment, reportSha256), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}.csv"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
