import { createHash } from "node:crypto";
import type {
  TrivyOperatorFinding,
  TrivyOperatorSeverity,
  TrivyOperatorSource,
  TrivySbomEvidence,
  TrivyScannerProvenance,
} from "./types.ts";

const TRIVY_API_VERSION = "aquasecurity.github.io/v1alpha1";
const MAX_FINDINGS_PER_REPORT = 5_000;
const MAX_COMPONENTS_PER_SBOM = 5_000;
const MAX_LICENSES_PER_COMPONENT = 64;

/** Official v1alpha1 Go/CRD contract pinned for the implemented field allowlist. */
export const TRIVY_OPERATOR_CONTRACT = {
  apiVersion: TRIVY_API_VERSION,
  upstreamCommit: "fa099f9ade081a0432f33d47ef4032e6ff22aa82",
} as const;

export interface TrivyOperatorReportDefinition {
  readonly collectorKey: string;
  readonly path: string;
  readonly kind:
    | "VulnerabilityReport"
    | "ClusterVulnerabilityReport"
    | "ConfigAuditReport"
    | "ExposedSecretReport"
    | "RbacAssessmentReport"
    | "ClusterRbacAssessmentReport"
    | "InfraAssessmentReport"
    | "ClusterInfraAssessmentReport"
    | "ClusterComplianceReport"
    | "SbomReport";
  readonly source: TrivyOperatorSource | "sbom_report";
}

export const trivyOperatorReports: readonly TrivyOperatorReportDefinition[] = [
  {
    collectorKey: "trivy-operator.vulnerabilityreports",
    path: "/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports",
    kind: "VulnerabilityReport",
    source: "vulnerability_report",
  },
  {
    collectorKey: "trivy-operator.clustervulnerabilityreports",
    path: "/apis/aquasecurity.github.io/v1alpha1/clustervulnerabilityreports",
    kind: "ClusterVulnerabilityReport",
    source: "cluster_vulnerability_report",
  },
  {
    collectorKey: "trivy-operator.configauditreports",
    path: "/apis/aquasecurity.github.io/v1alpha1/configauditreports",
    kind: "ConfigAuditReport",
    source: "config_audit_report",
  },
  {
    collectorKey: "trivy-operator.exposedsecretreports",
    path: "/apis/aquasecurity.github.io/v1alpha1/exposedsecretreports",
    kind: "ExposedSecretReport",
    source: "exposed_secret_report",
  },
  {
    collectorKey: "trivy-operator.infraassessmentreports",
    path: "/apis/aquasecurity.github.io/v1alpha1/infraassessmentreports",
    kind: "InfraAssessmentReport",
    source: "infra_assessment_report",
  },
  {
    collectorKey: "trivy-operator.clusterinfraassessmentreports",
    path: "/apis/aquasecurity.github.io/v1alpha1/clusterinfraassessmentreports",
    kind: "ClusterInfraAssessmentReport",
    source: "cluster_infra_assessment_report",
  },
  {
    collectorKey: "trivy-operator.clustercompliancereports",
    path: "/apis/aquasecurity.github.io/v1alpha1/clustercompliancereports",
    kind: "ClusterComplianceReport",
    source: "cluster_compliance_report",
  },
  {
    collectorKey: "trivy-operator.rbacassessmentreports",
    path: "/apis/aquasecurity.github.io/v1alpha1/rbacassessmentreports",
    kind: "RbacAssessmentReport",
    source: "rbac_assessment_report",
  },
  {
    collectorKey: "trivy-operator.clusterrbacassessmentreports",
    path: "/apis/aquasecurity.github.io/v1alpha1/clusterrbacassessmentreports",
    kind: "ClusterRbacAssessmentReport",
    source: "cluster_rbac_assessment_report",
  },
  {
    collectorKey: "trivy-operator.sbomreports",
    path: "/apis/aquasecurity.github.io/v1alpha1/sbomreports",
    kind: "SbomReport",
    source: "sbom_report",
  },
] as const;

export class TrivyOperatorEvidenceError extends Error {
  public readonly code: "INVALID_TRIVY_REPORT" | "TRIVY_REPORT_LIMIT_REACHED";

  public constructor(code: "INVALID_TRIVY_REPORT" | "TRIVY_REPORT_LIMIT_REACHED") {
    super("Trivy Operator report evidence was rejected");
    this.name = "TrivyOperatorEvidenceError";
    this.code = code;
  }
}

function invalid(): never {
  throw new TrivyOperatorEvidenceError("INVALID_TRIVY_REPORT");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: unknown, maximum = 253): string {
  const normalized = optionalString(value, maximum);
  if (normalized === null) invalid();
  return normalized;
}

function optionalString(value: unknown, maximum = 2_048): string | null {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function componentLicenses(value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LICENSES_PER_COMPONENT) invalid();
  const result: string[] = [];
  for (const raw of value) {
    const item = optionalRecord(raw);
    const license = optionalRecord(item.license);
    const identifier = optionalString(license.id, 128) ?? optionalString(license.name, 128);
    if (identifier === null) continue;
    result.push(identifier);
  }
  return [...new Set(result)].sort((left, right) => left.localeCompare(right));
}

function severity(value: unknown): TrivyOperatorSeverity {
  if (value === "CRITICAL") return "critical";
  if (value === "HIGH") return "high";
  if (value === "MEDIUM") return "medium";
  if (value === "LOW") return "low";
  return "unknown";
}

function fingerprint(parts: readonly (string | null)[]): string {
  return createHash("sha256").update(parts.map((part) => part ?? "").join("\u0000"), "utf8").digest("hex");
}

function metadata(item: Record<string, unknown>, clusterScoped: boolean) {
  if (item.apiVersion !== TRIVY_API_VERSION) invalid();
  const value = record(item.metadata);
  const name = requiredString(value.name);
  const uid = requiredString(value.uid, 128);
  const namespace = clusterScoped ? null : requiredString(value.namespace);
  const ownerReferences = Array.isArray(value.ownerReferences) ? value.ownerReferences.slice(0, 64) : [];
  const owner = ownerReferences.map(optionalRecord).find((candidate) => candidate.controller === true) ??
    ownerReferences.map(optionalRecord)[0] ?? {};
  const labels = optionalRecord(value.labels);
  return {
    name,
    uid,
    namespace,
    resourceVersion: optionalString(value.resourceVersion, 128),
    affectedResource: {
      kind: optionalString(owner.kind, 128) ?? optionalString(labels["trivy-operator.resource.kind"], 128),
      namespace: clusterScoped ? null : optionalString(labels["trivy-operator.resource.namespace"], 253) ?? namespace,
      name: optionalString(owner.name, 253) ?? optionalString(labels["trivy-operator.resource.name"], 253),
    },
  };
}

function scanner(report: Record<string, unknown>, reportMetadata: ReturnType<typeof metadata>): TrivyScannerProvenance {
  const value = record(report.scanner);
  const updateTimestamp = optionalString(report.updateTimestamp, 64);
  return {
    name: requiredString(value.name, 128),
    vendor: requiredString(value.vendor, 128),
    version: requiredString(value.version, 128),
    reportUid: reportMetadata.uid,
    reportResourceVersion: reportMetadata.resourceVersion,
    reportUpdatedAt: updateTimestamp !== null && Number.isFinite(Date.parse(updateTimestamp))
      ? new Date(updateTimestamp).toISOString()
      : null,
  };
}

function vulnerabilityFindings(
  definition: TrivyOperatorReportDefinition,
  item: Record<string, unknown>,
  clusterId: string,
): readonly TrivyOperatorFinding[] {
  const meta = metadata(item, definition.kind === "ClusterVulnerabilityReport");
  const report = record(item.report);
  const provenance = scanner(report, meta);
  if (!Array.isArray(report.vulnerabilities)) invalid();
  if (report.vulnerabilities.length > MAX_FINDINGS_PER_REPORT) {
    throw new TrivyOperatorEvidenceError("TRIVY_REPORT_LIMIT_REACHED");
  }
  return report.vulnerabilities.map((raw): TrivyOperatorFinding => {
    const finding = record(raw);
    const cveId = requiredString(finding.vulnerabilityID, 128);
    const packageName = requiredString(finding.resource, 512);
    const installedVersion = requiredString(finding.installedVersion, 512);
    const fixedVersion = optionalString(finding.fixedVersion, 512);
    const target = optionalString(finding.target, 1_024);
    const score = typeof finding.score === "number" && Number.isFinite(finding.score) && finding.score >= 0 && finding.score <= 10
      ? finding.score
      : null;
    return {
      fingerprint: fingerprint([
        definition.source, clusterId, meta.namespace, meta.name,
        meta.affectedResource.kind, meta.affectedResource.name,
        cveId, packageName, target,
      ]),
      clusterId,
      source: definition.source === "cluster_vulnerability_report"
        ? "cluster_vulnerability_report"
        : "vulnerability_report",
      severity: severity(finding.severity),
      namespace: meta.namespace,
      reportName: meta.name,
      affectedResource: meta.affectedResource,
      title: optionalString(finding.title, 512) ?? cveId,
      checkId: null,
      cveId,
      packageName,
      packageType: optionalString(finding.packageType, 128),
      installedVersion,
      fixedVersion,
      target,
      score,
      remediation: fixedVersion === null ? null : `Upgrade ${packageName} to ${fixedVersion}`,
      scanner: provenance,
    };
  });
}

function checkFindings(
  definition: TrivyOperatorReportDefinition,
  item: Record<string, unknown>,
  clusterId: string,
): readonly TrivyOperatorFinding[] {
  const clusterScoped = definition.kind === "ClusterRbacAssessmentReport" ||
    definition.kind === "ClusterInfraAssessmentReport";
  const meta = metadata(item, clusterScoped);
  const report = record(item.report);
  const provenance = scanner(report, meta);
  if (!Array.isArray(report.checks)) invalid();
  if (report.checks.length > MAX_FINDINGS_PER_REPORT) {
    throw new TrivyOperatorEvidenceError("TRIVY_REPORT_LIMIT_REACHED");
  }
  return report.checks.flatMap((raw): TrivyOperatorFinding[] => {
    const check = record(raw);
    if (typeof check.success !== "boolean") invalid();
    if (check.success) return [];
    const checkId = requiredString(check.checkID, 128);
    const scope = optionalRecord(check.scope);
    const scopeType = optionalString(scope.type, 128);
    const scopeValue = optionalString(scope.value, 1_024);
    return [{
      fingerprint: fingerprint([
        definition.source, clusterId, meta.namespace, meta.name,
        meta.affectedResource.kind, meta.affectedResource.name,
        checkId, scopeType, scopeValue,
      ]),
      clusterId,
      source: definition.source as Exclude<TrivyOperatorSource, "vulnerability_report">,
      severity: severity(check.severity),
      namespace: meta.namespace,
      reportName: meta.name,
      affectedResource: meta.affectedResource,
      title: optionalString(check.title, 512) ?? checkId,
      checkId,
      cveId: null,
      packageName: null,
      packageType: null,
      installedVersion: null,
      fixedVersion: null,
      target: scopeType === null || scopeValue === null ? null : `${scopeType}:${scopeValue}`,
      score: null,
      remediation: optionalString(check.remediation, 2_048),
      scanner: provenance,
    }];
  });
}

/**
 * ExposedSecretReport deliberately excludes `match`, which can contain the
 * credential material. Only the rule identity and file/image target are
 * retained, and the stable fingerprint is derived exclusively from those
 * sanitized fields.
 */
function exposedSecretFindings(
  definition: TrivyOperatorReportDefinition,
  item: Record<string, unknown>,
  clusterId: string,
): readonly TrivyOperatorFinding[] {
  const meta = metadata(item, false);
  const report = record(item.report);
  const provenance = scanner(report, meta);
  if (!Array.isArray(report.secrets)) invalid();
  if (report.secrets.length > MAX_FINDINGS_PER_REPORT) {
    throw new TrivyOperatorEvidenceError("TRIVY_REPORT_LIMIT_REACHED");
  }
  return report.secrets.map((raw): TrivyOperatorFinding => {
    const secret = record(raw);
    const ruleId = requiredString(secret.ruleID, 256);
    const target = requiredString(secret.target, 1_024);
    const title = optionalString(secret.title, 512) ?? ruleId;
    const category = optionalString(secret.category, 256);
    return {
      fingerprint: fingerprint([
        definition.source, clusterId, meta.namespace, meta.name,
        meta.affectedResource.kind, meta.affectedResource.name, ruleId, target,
      ]),
      clusterId,
      source: "exposed_secret_report",
      severity: severity(secret.severity),
      namespace: meta.namespace,
      reportName: meta.name,
      affectedResource: meta.affectedResource,
      title: category === null ? title : `${title} (${category})`,
      checkId: ruleId,
      cveId: null,
      packageName: null,
      packageType: null,
      installedVersion: null,
      fixedVersion: null,
      target,
      score: null,
      remediation: "Remove the exposed credential from the image, rotate it, rebuild the image, and rescan",
      scanner: provenance,
    };
  });
}

function complianceFindings(
  definition: TrivyOperatorReportDefinition,
  item: Record<string, unknown>,
  clusterId: string,
): readonly TrivyOperatorFinding[] {
  const meta = metadata(item, true);
  const spec = record(item.spec);
  const compliance = record(spec.compliance);
  // Trivy creates the ClusterComplianceReport definitions before the first
  // scheduled evaluation has populated status. An absent status is valid
  // "not yet evaluated" evidence, not a malformed Kubernetes response.
  const status = optionalRecord(item.status);
  const detail = optionalRecord(status.detailReport);
  const summary = optionalRecord(status.summaryReport);
  const updateTimestamp = optionalString(status.updateTimestamp, 64);
  const labels = optionalRecord(record(item.metadata).labels);
  const provenance: TrivyScannerProvenance = {
    name: "Trivy Operator",
    vendor: "Aqua Security",
    version: optionalString(labels["app.kubernetes.io/version"], 128) ?? "unknown",
    reportUid: meta.uid,
    reportResourceVersion: meta.resourceVersion,
    reportUpdatedAt: updateTimestamp !== null && Number.isFinite(Date.parse(updateTimestamp))
      ? new Date(updateTimestamp).toISOString()
      : null,
  };
  const detailResults = Array.isArray(detail.results) ? detail.results : [];
  const summaryResults = Array.isArray(summary.controlCheck) ? summary.controlCheck : [];
  if (detailResults.length > MAX_FINDINGS_PER_REPORT || summaryResults.length > MAX_FINDINGS_PER_REPORT) {
    throw new TrivyOperatorEvidenceError("TRIVY_REPORT_LIMIT_REACHED");
  }
  if (detailResults.length > 0) {
    let observedChecks = 0;
    const findings: TrivyOperatorFinding[] = [];
    for (const raw of detailResults) {
      const control = record(raw);
      const controlId = requiredString(control.id, 256);
      if (!Array.isArray(control.checks)) invalid();
      observedChecks += control.checks.length;
      if (observedChecks > MAX_FINDINGS_PER_REPORT) {
        throw new TrivyOperatorEvidenceError("TRIVY_REPORT_LIMIT_REACHED");
      }
      for (const rawCheck of control.checks) {
        const check = record(rawCheck);
        if (typeof check.success !== "boolean") invalid();
        if (check.success) continue;
        const checkId = requiredString(check.checkID, 256);
        const target = optionalString(check.target, 1_024);
        findings.push({
          fingerprint: fingerprint([
            definition.source, clusterId, meta.name, controlId, checkId, target,
          ]),
          clusterId,
          source: "cluster_compliance_report",
          severity: severity(check.severity ?? control.severity),
          namespace: null,
          reportName: meta.name,
          affectedResource: { kind: "Cluster", namespace: null, name: clusterId },
          title: optionalString(check.title, 512) ?? optionalString(control.name, 512) ?? checkId,
          checkId,
          cveId: null,
          packageName: null,
          packageType: null,
          installedVersion: null,
          fixedVersion: null,
          target,
          score: null,
          remediation: optionalString(check.remediation, 2_048) ??
            "Review the failed compliance check and remediate the mapped Kubernetes configuration",
          scanner: provenance,
        });
      }
    }
    return findings;
  }
  return summaryResults.flatMap((raw): TrivyOperatorFinding[] => {
    const control = record(raw);
    const controlId = requiredString(control.id, 256);
    const totalFail = nonNegativeInteger(control.totalFail);
    if (totalFail === null) invalid();
    if (totalFail === 0) return [];
    return [{
      fingerprint: fingerprint([definition.source, clusterId, meta.name, controlId]),
      clusterId,
      source: "cluster_compliance_report",
      severity: severity(control.severity),
      namespace: null,
      reportName: meta.name,
      affectedResource: { kind: "Cluster", namespace: null, name: clusterId },
      title: optionalString(control.name, 512) ?? controlId,
      checkId: controlId,
      cveId: null,
      packageName: null,
      packageType: null,
      installedVersion: null,
      fixedVersion: null,
      target: optionalString(compliance.id, 256) ?? meta.name,
      score: null,
      remediation: "Review the failed compliance control evidence and remediate the mapped Kubernetes configuration",
      scanner: provenance,
    }];
  });
}

function sbomEvidence(item: Record<string, unknown>, clusterId: string): TrivySbomEvidence {
  const meta = metadata(item, false);
  const report = record(item.report);
  const provenance = scanner(report, meta);
  const artifact = optionalRecord(report.artifact);
  const summary = optionalRecord(report.summary);
  const bom = record(report.components);
  if (!Array.isArray(bom.components)) invalid();
  if (bom.components.length > MAX_COMPONENTS_PER_SBOM) {
    throw new TrivyOperatorEvidenceError("TRIVY_REPORT_LIMIT_REACHED");
  }
  const components = bom.components.map((raw) => {
    const component = record(raw);
    const name = requiredString(component.name, 1_024);
    const version = optionalString(component.version, 512);
    const packageUrl = optionalString(component.purl, 2_048);
    return {
      fingerprint: fingerprint(["sbom_component", clusterId, meta.namespace, meta.name, name, version, packageUrl]),
      type: optionalString(component.type, 128),
      name,
      version,
      packageUrl,
      licenses: componentLicenses(component.licenses),
    };
  });
  const repository = optionalString(artifact.repository, 1_024);
  const digest = optionalString(artifact.digest, 256);
  const tag = optionalString(artifact.tag, 512);
  return {
    fingerprint: fingerprint(["sbom_report", clusterId, meta.namespace, meta.name, repository, digest, tag]),
    clusterId,
    namespace: meta.namespace,
    reportName: meta.name,
    affectedResource: meta.affectedResource,
    artifact: { repository, digest, tag },
    bomFormat: optionalString(bom.bomFormat, 128),
    specVersion: optionalString(bom.specVersion, 64),
    declaredComponentCount: nonNegativeInteger(summary.componentsCount),
    declaredDependencyCount: nonNegativeInteger(summary.dependenciesCount),
    components,
    scanner: provenance,
  };
}

export function normalizeTrivyOperatorReport(
  definition: TrivyOperatorReportDefinition,
  value: unknown,
  clusterId: string,
): { readonly findings: readonly TrivyOperatorFinding[]; readonly sboms: readonly TrivySbomEvidence[] } {
  const item = record(value);
  if (item.kind !== definition.kind) invalid();
  if (definition.source === "sbom_report") {
    return { findings: [], sboms: [sbomEvidence(item, clusterId)] };
  }
  if (definition.source === "vulnerability_report" || definition.source === "cluster_vulnerability_report") {
    return { findings: vulnerabilityFindings(definition, item, clusterId), sboms: [] };
  }
  if (definition.source === "exposed_secret_report") {
    return { findings: exposedSecretFindings(definition, item, clusterId), sboms: [] };
  }
  if (definition.source === "cluster_compliance_report") {
    return { findings: complianceFindings(definition, item, clusterId), sboms: [] };
  }
  return { findings: checkFindings(definition, item, clusterId), sboms: [] };
}
