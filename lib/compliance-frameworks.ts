export type ReadinessState = "PASS" | "FAIL" | "UNKNOWN" | "NOT_COLLECTED";

export type CollectedControlState = "PASS" | "FAIL" | "UNKNOWN";

export type ComplianceFrameworkAvailability =
  | "available"
  | "mapping-review-required"
  | "licensed-content-required";

export type ComplianceFrameworkId =
  | "pci-dss-v4"
  | "hipaa-security-rule"
  | "iso-27001-2022-annex-a"
  | "nist-csf-2.0"
  | "soc-2-tsc";

export interface ComplianceFrameworkControl {
  /** The framework's own control identifier (e.g. "CC6.1", "A.5.15", "164.312(b)"). */
  readonly controlId: string;
  readonly title: string;
  /** Collected Sutra control ids whose evidence informs this framework control. */
  readonly sutraControlIds: readonly string[];
}

export interface ComplianceFramework {
  readonly id: ComplianceFrameworkId;
  readonly title: string;
  readonly availability: ComplianceFrameworkAvailability;
  readonly claimBoundary: string;
  readonly controls: readonly ComplianceFrameworkControl[];
}

export interface CollectedControlResult {
  /** A Sutra-owned control id emitted by a collector (e.g. "SUTRA.AWS.S3.PUBLIC_ACCESS_BLOCK"). */
  readonly controlId: string;
  readonly state: CollectedControlState;
}

export interface ReadinessScope {
  readonly tenantId: string | null;
  readonly collectionId: string | null;
  /** Caller-supplied ISO timestamp of the underlying collection; never read from the clock. */
  readonly collectedAt: string | null;
}

export interface MappedControlEvidence {
  readonly sutraControlId: string;
  /** The mapped Sutra control's resolved state, or NOT_COLLECTED when it was absent from the input. */
  readonly state: ReadinessState;
}

export interface FrameworkReadinessControl {
  readonly controlId: string;
  readonly title: string;
  readonly state: ReadinessState;
  readonly mappedSutraControlIds: readonly string[];
  readonly mappedEvidence: readonly MappedControlEvidence[];
  readonly passCount: number;
  readonly failCount: number;
  readonly unknownCount: number;
  readonly notCollectedCount: number;
}

export type ReadinessStateCounts = Readonly<Record<ReadinessState, number>>;

export interface FrameworkIdentity {
  readonly id: ComplianceFrameworkId;
  readonly title: string;
  readonly availability: ComplianceFrameworkAvailability;
  readonly claimBoundary: string;
}

export interface FrameworkReadiness {
  readonly schema: "sutra.compliance-framework-readiness.v1";
  readonly framework: FrameworkIdentity;
  readonly scope: ReadinessScope;
  readonly controls: readonly FrameworkReadinessControl[];
  readonly summary: ReadinessStateCounts;
  /** Collected Sutra control ids that do not map to any control in this framework. */
  readonly unmappedControlIds: readonly string[];
  readonly disclaimer: string;
}

export interface AuditExportRow {
  readonly controlId: string;
  readonly title: string;
  readonly state: ReadinessState;
  readonly mappedEvidence: readonly MappedControlEvidence[];
  readonly disclaimer: string;
}

export interface AuditExport {
  readonly schema: "sutra.compliance-audit-export.v1";
  readonly framework: FrameworkIdentity;
  readonly scope: ReadinessScope;
  readonly generatedFromCounts: ReadinessStateCounts;
  readonly rows: readonly AuditExportRow[];
  readonly disclaimer: string;
}

export const COMPLIANCE_READINESS_DISCLAIMER =
  "Readiness mapping over the exact collected point-in-time control evidence only; " +
  "not a certification, audit opinion, or proof of operating effectiveness. Framework " +
  "control relationships are informative and must be validated with your assessor or auditor.";

const INFORMATIVE_BOUNDARY =
  "Informative readiness relationships only; the customer's control environment, evidence period, " +
  "scope and independent assessor determine applicability. Not a certification or audit opinion.";

const LICENSED_BOUNDARY =
  "Informative readiness relationships against publicly referenced control identifiers only; a licensed " +
  "current copy of the standard is required to approve exact control-text mappings. Not a certification.";

export const UNKNOWN_READINESS_SCOPE: ReadinessScope = {
  tenantId: null,
  collectionId: null,
  collectedAt: null,
};

export const COMPLIANCE_FRAMEWORKS: readonly ComplianceFramework[] = [
  {
    id: "pci-dss-v4",
    title: "PCI DSS v4.0",
    availability: "mapping-review-required",
    claimBoundary: INFORMATIVE_BOUNDARY,
    controls: [
      {
        controlId: "1.3.1",
        title: "Inbound traffic to the cardholder data environment is restricted",
        sutraControlIds: [
          "SUTRA.AWS.EC2.SSH_PUBLIC",
          "SUTRA.AWS.EC2.PUBLIC_IP",
          "SUTRA.AWS.RDS.PUBLIC_ACCESS",
          "K8S-NAMESPACE-NETWORK-POLICY",
        ],
      },
      {
        controlId: "2.2.1",
        title: "System components are configured and managed to secure standards",
        sutraControlIds: [
          "SUTRA.AWS.EC2.IMDSV2_REQUIRED",
          "K8S-WORKLOAD-NO-PRIVILEGED",
          "K8S-WORKLOAD-RUN-AS-NON-ROOT",
        ],
      },
      {
        controlId: "3.5.1",
        title: "Stored primary account number is rendered unreadable",
        sutraControlIds: ["SUTRA.AWS.RDS.STORAGE_ENCRYPTED"],
      },
      {
        controlId: "7.2.1",
        title: "An access control model enforces least privilege",
        sutraControlIds: ["K8S-RBAC-WILDCARDS"],
      },
      {
        controlId: "8.3.1",
        title: "Strong authentication is enforced for all accounts",
        sutraControlIds: ["SUTRA.AWS.IAM.PASSWORD_POLICY"],
      },
      {
        controlId: "10.2.1",
        title: "Audit logs capture access to system components",
        sutraControlIds: ["SUTRA.AWS.CLOUDTRAIL.LOGGING"],
      },
      {
        controlId: "11.5.1",
        title: "Intrusion detection monitors the network for anomalies",
        sutraControlIds: ["SUTRA.AWS.GUARDDUTY.ENABLED"],
      },
    ],
  },
  {
    id: "hipaa-security-rule",
    title: "HIPAA Security Rule (45 CFR Part 164, Subpart C)",
    availability: "mapping-review-required",
    claimBoundary: INFORMATIVE_BOUNDARY,
    controls: [
      {
        controlId: "164.312(a)(1)",
        title: "Access Control",
        sutraControlIds: [
          "K8S-RBAC-WILDCARDS",
          "SUTRA.AWS.IAM.PASSWORD_POLICY",
          "SUTRA.AWS.S3.PUBLIC_ACCESS_BLOCK",
        ],
      },
      {
        controlId: "164.312(a)(2)(iv)",
        title: "Encryption and Decryption",
        sutraControlIds: ["SUTRA.AWS.RDS.STORAGE_ENCRYPTED"],
      },
      {
        controlId: "164.312(b)",
        title: "Audit Controls",
        sutraControlIds: ["SUTRA.AWS.CLOUDTRAIL.LOGGING"],
      },
      {
        controlId: "164.312(e)(1)",
        title: "Transmission Security",
        sutraControlIds: ["K8S-INGRESS-TLS"],
      },
      {
        controlId: "164.308(a)(1)(ii)(D)",
        title: "Information System Activity Review",
        sutraControlIds: ["SUTRA.AWS.GUARDDUTY.ENABLED", "SUTRA.AWS.SECURITYHUB.ENABLED"],
      },
      {
        controlId: "164.308(a)(4)(i)",
        title: "Information Access Management",
        sutraControlIds: ["SUTRA.AWS.RDS.PUBLIC_ACCESS", "SUTRA.AWS.EC2.PUBLIC_IP"],
      },
    ],
  },
  {
    id: "iso-27001-2022-annex-a",
    title: "ISO/IEC 27001:2022 Annex A",
    availability: "licensed-content-required",
    claimBoundary: LICENSED_BOUNDARY,
    controls: [
      {
        controlId: "A.5.15",
        title: "Access control",
        sutraControlIds: ["K8S-RBAC-WILDCARDS", "SUTRA.AWS.IAM.PASSWORD_POLICY"],
      },
      {
        controlId: "A.8.2",
        title: "Privileged access rights",
        sutraControlIds: ["K8S-RBAC-WILDCARDS", "K8S-WORKLOAD-NO-PRIVILEGED"],
      },
      {
        controlId: "A.8.9",
        title: "Configuration management",
        sutraControlIds: ["SUTRA.AWS.EC2.IMDSV2_REQUIRED", "K8S-WORKLOAD-RUN-AS-NON-ROOT"],
      },
      {
        controlId: "A.8.15",
        title: "Logging",
        sutraControlIds: ["SUTRA.AWS.CLOUDTRAIL.LOGGING"],
      },
      {
        controlId: "A.8.16",
        title: "Monitoring activities",
        sutraControlIds: ["SUTRA.AWS.GUARDDUTY.ENABLED", "SUTRA.AWS.SECURITYHUB.ENABLED"],
      },
      {
        controlId: "A.8.20",
        title: "Networks security",
        sutraControlIds: ["SUTRA.AWS.EC2.SSH_PUBLIC", "K8S-NAMESPACE-NETWORK-POLICY"],
      },
      {
        controlId: "A.8.24",
        title: "Use of cryptography",
        sutraControlIds: ["SUTRA.AWS.RDS.STORAGE_ENCRYPTED", "K8S-INGRESS-TLS"],
      },
    ],
  },
  {
    id: "nist-csf-2.0",
    title: "NIST Cybersecurity Framework 2.0",
    availability: "mapping-review-required",
    claimBoundary: INFORMATIVE_BOUNDARY,
    controls: [
      {
        controlId: "PR.AA-05",
        title: "Access permissions and authorizations are managed with least privilege",
        sutraControlIds: ["K8S-RBAC-WILDCARDS", "SUTRA.AWS.IAM.PASSWORD_POLICY"],
      },
      {
        controlId: "PR.DS-01",
        title: "The confidentiality, integrity and availability of data-at-rest are protected",
        sutraControlIds: ["SUTRA.AWS.RDS.STORAGE_ENCRYPTED", "SUTRA.AWS.S3.PUBLIC_ACCESS_BLOCK"],
      },
      {
        controlId: "PR.DS-02",
        title: "The confidentiality, integrity and availability of data-in-transit are protected",
        sutraControlIds: ["K8S-INGRESS-TLS"],
      },
      {
        controlId: "PR.PS-01",
        title: "Configuration management practices are established and applied",
        sutraControlIds: ["SUTRA.AWS.EC2.IMDSV2_REQUIRED", "K8S-WORKLOAD-NO-PRIVILEGED"],
      },
      {
        controlId: "PR.IR-01",
        title: "Networks and environments are protected from unauthorized logical access",
        sutraControlIds: ["SUTRA.AWS.EC2.SSH_PUBLIC", "K8S-NAMESPACE-NETWORK-POLICY"],
      },
      {
        controlId: "DE.CM-01",
        title: "Networks and network services are monitored to find adverse events",
        sutraControlIds: ["SUTRA.AWS.GUARDDUTY.ENABLED"],
      },
    ],
  },
  {
    id: "soc-2-tsc",
    title: "SOC 2 (AICPA Trust Services Criteria)",
    availability: "mapping-review-required",
    claimBoundary: INFORMATIVE_BOUNDARY,
    controls: [
      {
        controlId: "CC6.1",
        title: "Logical access security restricts access to information assets",
        sutraControlIds: [
          "K8S-RBAC-WILDCARDS",
          "SUTRA.AWS.IAM.PASSWORD_POLICY",
          "SUTRA.AWS.S3.PUBLIC_ACCESS_BLOCK",
        ],
      },
      {
        controlId: "CC6.6",
        title: "Logical access controls protect against threats from outside system boundaries",
        sutraControlIds: [
          "SUTRA.AWS.EC2.SSH_PUBLIC",
          "SUTRA.AWS.EC2.PUBLIC_IP",
          "K8S-NAMESPACE-NETWORK-POLICY",
        ],
      },
      {
        controlId: "CC6.7",
        title: "Data is protected during transmission",
        sutraControlIds: ["K8S-INGRESS-TLS"],
      },
      {
        controlId: "CC6.8",
        title: "Controls prevent or detect unauthorized or malicious software",
        sutraControlIds: ["K8S-IMAGE-DIGEST", "K8S-WORKLOAD-NO-PRIVILEGED"],
      },
      {
        controlId: "CC7.1",
        title: "Configuration changes and vulnerabilities are detected",
        sutraControlIds: ["SUTRA.AWS.EC2.IMDSV2_REQUIRED", "SUTRA.AWS.CLOUDTRAIL.LOGGING"],
      },
      {
        controlId: "CC7.2",
        title: "System components are monitored to detect anomalies",
        sutraControlIds: ["SUTRA.AWS.GUARDDUTY.ENABLED", "SUTRA.AWS.SECURITYHUB.ENABLED"],
      },
      {
        controlId: "C1.1",
        title: "Confidential information is protected to meet the entity's objectives",
        sutraControlIds: ["SUTRA.AWS.RDS.STORAGE_ENCRYPTED"],
      },
    ],
  },
] as const;

export function getComplianceFramework(
  frameworkId: ComplianceFrameworkId,
): ComplianceFramework | undefined {
  return COMPLIANCE_FRAMEWORKS.find((framework) => framework.id === frameworkId);
}

function frameworkIdentity(framework: ComplianceFramework): FrameworkIdentity {
  return {
    id: framework.id,
    title: framework.title,
    availability: framework.availability,
    claimBoundary: framework.claimBoundary,
  };
}

function emptyCounts(): Record<ReadinessState, number> {
  return { PASS: 0, FAIL: 0, UNKNOWN: 0, NOT_COLLECTED: 0 };
}

/**
 * Collapses every collected result for a single Sutra control id into one state.
 * Conservative: an UNKNOWN contaminates the id; otherwise a FAIL wins over PASS.
 * Only called with a non-empty list, so a resolved state always exists.
 */
function resolveCollectedState(
  states: readonly CollectedControlState[],
): CollectedControlState {
  if (states.some((state) => state === "UNKNOWN")) return "UNKNOWN";
  if (states.some((state) => state === "FAIL")) return "FAIL";
  return "PASS";
}

/**
 * Aggregates a framework control from its mapped Sutra evidence. Evidence-honest:
 * never PASS unless every mapped id was collected and PASSed; propagate UNKNOWN
 * whenever any mapped result is unknown or any mapped id is missing evidence;
 * NOT_COLLECTED when none of the mapped ids were collected. A concrete FAIL is
 * still surfaced per-id in mappedEvidence even when the aggregate is UNKNOWN.
 */
function aggregateControlState(counts: {
  readonly passCount: number;
  readonly failCount: number;
  readonly unknownCount: number;
  readonly notCollectedCount: number;
}): ReadinessState {
  if (counts.passCount + counts.failCount + counts.unknownCount === 0) return "NOT_COLLECTED";
  if (counts.unknownCount > 0) return "UNKNOWN";
  if (counts.failCount > 0) return "FAIL";
  if (counts.notCollectedCount > 0) return "UNKNOWN";
  return "PASS";
}

export function buildFrameworkReadiness(
  collectedControlResults: readonly CollectedControlResult[],
  frameworkId: ComplianceFrameworkId,
  scope: ReadinessScope = UNKNOWN_READINESS_SCOPE,
): FrameworkReadiness {
  const framework = getComplianceFramework(frameworkId);
  if (framework === undefined) {
    throw new Error(`Compliance framework ${frameworkId} is not in the catalog`);
  }

  const statesById = new Map<string, CollectedControlState[]>();
  for (const result of collectedControlResults) {
    const existing = statesById.get(result.controlId);
    if (existing === undefined) statesById.set(result.controlId, [result.state]);
    else existing.push(result.state);
  }
  const resolvedById = new Map<string, CollectedControlState>();
  for (const [controlId, states] of statesById) {
    resolvedById.set(controlId, resolveCollectedState(states));
  }

  const mappedSutraIds = new Set<string>();
  const controls = framework.controls.map((control) => {
    let passCount = 0;
    let failCount = 0;
    let unknownCount = 0;
    let notCollectedCount = 0;
    const mappedEvidence: MappedControlEvidence[] = control.sutraControlIds.map((sutraControlId) => {
      mappedSutraIds.add(sutraControlId);
      const resolved = resolvedById.get(sutraControlId);
      if (resolved === undefined) {
        notCollectedCount += 1;
        return { sutraControlId, state: "NOT_COLLECTED" as ReadinessState };
      }
      if (resolved === "PASS") passCount += 1;
      else if (resolved === "FAIL") failCount += 1;
      else unknownCount += 1;
      return { sutraControlId, state: resolved };
    });
    return {
      controlId: control.controlId,
      title: control.title,
      state: aggregateControlState({ passCount, failCount, unknownCount, notCollectedCount }),
      mappedSutraControlIds: control.sutraControlIds,
      mappedEvidence,
      passCount,
      failCount,
      unknownCount,
      notCollectedCount,
    };
  });

  const summary = emptyCounts();
  for (const control of controls) summary[control.state] += 1;

  const unmappedControlIds = [...resolvedById.keys()]
    .filter((controlId) => !mappedSutraIds.has(controlId))
    .sort((left, right) => left.localeCompare(right, "en-US"));

  return {
    schema: "sutra.compliance-framework-readiness.v1",
    framework: frameworkIdentity(framework),
    scope,
    controls,
    summary,
    unmappedControlIds,
    disclaimer: COMPLIANCE_READINESS_DISCLAIMER,
  };
}

export function buildAuditExport(readiness: FrameworkReadiness): AuditExport {
  const rows: AuditExportRow[] = readiness.controls.map((control) => ({
    controlId: control.controlId,
    title: control.title,
    state: control.state,
    mappedEvidence: control.mappedEvidence,
    disclaimer: readiness.disclaimer,
  }));
  return {
    schema: "sutra.compliance-audit-export.v1",
    framework: readiness.framework,
    scope: readiness.scope,
    generatedFromCounts: readiness.summary,
    rows,
    disclaimer: readiness.disclaimer,
  };
}
