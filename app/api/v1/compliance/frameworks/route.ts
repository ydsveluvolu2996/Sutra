import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { listComplianceExceptions } from "../../../../../db/compliance-exception-repository";
import { ComplianceWorkspaceRepository } from "../../../../../db/compliance-workspace-repository";
import { assertSessionCapability } from "../../../../../lib/api-auth";
import { applyComplianceExceptions } from "../../../../../lib/compliance-exception-types";
import { buildComplianceEvidencePack } from "../../../../../lib/compliance-evidence-pack";
import { buildKubernetesComplianceReadinessReport } from "../../../../../lib/kubernetes-compliance-readiness";
import { collectComplianceInputs } from "../../../../../lib/compliance-collected";
import {
  buildAuditExport,
  buildFrameworkReadiness,
  COMPLIANCE_FRAMEWORKS,
  type AuditExport,
  type ComplianceFrameworkId,
  type FrameworkReadiness,
} from "../../../../../lib/compliance-frameworks";
import { canonicalJson } from "../../../../../lib/canonical-json";
import { errorResponse, jsonResponse, requirePilotActor } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const FRAMEWORK_IDS = new Set<ComplianceFrameworkId>(
  COMPLIANCE_FRAMEWORKS.map((framework) => framework.id),
);
type ExportFormat = "view" | "json" | "csv" | "pack";

function invalid(): never {
  throw Object.assign(new Error("The compliance framework request is invalid"), { code: "INVALID_INPUT" });
}

// Spreadsheet-injection guard + CSV quoting, identical to the AWS compliance export.
function safeSpreadsheetText(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
}
function csvCell(value: unknown): string {
  return `"${safeSpreadsheetText(value).replaceAll('"', '""')}"`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function auditCsv(auditExport: AuditExport, reportSha256: string): string {
  const header = [
    "report_sha256", "framework_id", "framework_title", "availability",
    "control_id", "control_title", "state", "mapped_evidence", "claim_boundary",
  ];
  const rows = auditExport.rows.map((row) => [
    reportSha256, auditExport.framework.id, auditExport.framework.title, auditExport.framework.availability,
    row.controlId, row.title, row.state,
    row.mappedEvidence.map((entry) => `${entry.sutraControlId}:${entry.state}`).join(";"),
    auditExport.framework.claimBoundary,
  ]);
  return `${header.map(csvCell).join(",")}\r\n${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !["connectionId", "framework", "format"].includes(key))) invalid();
    const connectionId = url.searchParams.get("connectionId");
    const frameworkParam = url.searchParams.get("framework");
    const format = (url.searchParams.get("format") ?? "view") as ExportFormat;
    if (
      connectionId === null || !CONNECTION_ID.test(connectionId) ||
      (format !== "view" && format !== "json" && format !== "csv" && format !== "pack") ||
      (frameworkParam !== null && !FRAMEWORK_IDS.has(frameworkParam as ComplianceFrameworkId))
    ) invalid();
    // The per-framework json/csv exports require a framework; view and pack do not.
    if (format !== "view" && format !== "pack" && frameworkParam === null) invalid();

    const actor = await requirePilotActor(request, "workspace:read");
    const connection = await getConnectionForOrg(actor.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(
      actor.authenticated,
      format === "view" ? "connection:read" : "export:read",
      connection.customerId,
    );
    const isPack = format === "pack";

    const inputs = await collectComplianceInputs({
      orgId: actor.orgId,
      customerId: connection.customerId,
      connectionId,
    });
    const { collected, assessment, k8sFindings, k8sCollectedAt, k8sScanSha256, readinessScope } = inputs;

    if (isPack) {
      // Single auditor-grade artifact: AWS baseline (governed exceptions applied),
      // Kubernetes readiness (with its cited evidence trail), and all five
      // framework readinesses, under one hash and one attestation envelope.
      const exceptionRecords = await listComplianceExceptions({
        orgId: actor.orgId,
        customerId: connection.customerId,
        connectionId,
      });
      const awsWithExceptions = applyComplianceExceptions(assessment, exceptionRecords);
      const kubernetes = buildKubernetesComplianceReadinessReport({
        findings: k8sFindings,
        collectedAt: k8sCollectedAt,
      });
      const frameworks: FrameworkReadiness[] = [...FRAMEWORK_IDS].map((id) =>
        buildFrameworkReadiness(collected, id, readinessScope),
      );
      const pack = buildComplianceEvidencePack({
        aws: awsWithExceptions,
        kubernetes,
        frameworks,
        kubernetesScanSha256: k8sScanSha256,
      });
      const reportSha256 = await sha256Hex(canonicalJson(pack));
      // The attestation (generation time + actor + connection) is intentionally
      // OUTSIDE the hashed pack bytes so the pack itself stays deterministic.
      const attestation = {
        generatedAt: new Date().toISOString(),
        connectionId,
        actorId: actor.authenticated.subject.userId,
      };
      const account = assessment.provenance.awsAccountId ?? "unscoped";
      return new Response(canonicalJson({ ...pack, reportSha256, attestation }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="sutra-compliance-evidence-pack-${account}.json"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (format === "view") {
      const frameworks: FrameworkReadiness[] = [...FRAMEWORK_IDS].map((id) =>
        buildFrameworkReadiness(collected, id, readinessScope),
      );
      const reportCore = {
        schemaVersion: "sutra.compliance-frameworks.v1" as const,
        frameworks,
        scope: readinessScope,
        evidence: {
          awsControls: inputs.awsResultCount,
          kubernetesControls: inputs.kubernetesResultCount,
          clusters: inputs.activeClusterCount,
          snapshotCoverageState: assessment.provenance.snapshotCoverageState,
        },
      };
      const reportSha256 = await sha256Hex(canonicalJson(reportCore));
      // Record one trend point per framework for this snapshot (idempotent);
      // the trend series only ever reflects evaluations that actually ran.
      const snapshotId = assessment.provenance.snapshotId;
      const collectedAtMs = assessment.provenance.snapshotCollectedAt === null
        ? Number.NaN
        : Date.parse(assessment.provenance.snapshotCollectedAt);
      if (snapshotId !== null && Number.isFinite(collectedAtMs)) {
        const workspaceRepository = new ComplianceWorkspaceRepository();
        const trendScope = { orgId: actor.orgId, customerId: connection.customerId };
        for (const framework of frameworks) {
          await workspaceRepository.recordTrendPoint(trendScope, connectionId, framework.framework.id, {
            snapshotId,
            collectedAtMs,
            passCount: framework.summary.PASS,
            failCount: framework.summary.FAIL,
            unknownCount: framework.summary.UNKNOWN,
            notCollectedCount: framework.summary.NOT_COLLECTED,
          });
        }
      }
      return jsonResponse({ ...reportCore, reportSha256 });
    }

    const frameworkId = frameworkParam as ComplianceFrameworkId;
    const readiness = buildFrameworkReadiness(collected, frameworkId, readinessScope);
    const auditExport = buildAuditExport(readiness);
    const reportSha256 = await sha256Hex(canonicalJson(auditExport));
    const account = assessment.provenance.awsAccountId ?? "unscoped";
    const filename = `sutra-${frameworkId}-${account}`;
    if (format === "json") {
      return new Response(canonicalJson({ ...auditExport, reportSha256 }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${filename}.json"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    return new Response(auditCsv(auditExport, reportSha256), {
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
