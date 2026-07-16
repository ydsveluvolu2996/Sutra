import {
  SUTRA_AWS_BASELINE,
  type ComplianceControlCatalog,
  type ComplianceControlDefinition,
  type ComplianceControlScope,
  type ComplianceCoverageRequirement,
  type ComplianceFrameworkMapping,
} from "./compliance-catalog.ts";
import { ALL_ENABLED_AWS_REGIONS } from "./aws-region-selection.ts";
import type {
  CoverageStatus,
  FindingSeverity,
  PilotFinding,
  PilotState,
} from "./pilot-types.ts";

export const COMPLIANCE_ASSESSMENT_DISCLAIMER =
  "A Sutra assessment is a point-in-time interpretation of the referenced AWS inventory snapshot and its explicit collector coverage. It does not establish certification, audit opinion, exploitability, vulnerability coverage, or the absence of threats.";

export type ComplianceStatus =
  | "PASS"
  | "FAIL"
  | "UNKNOWN"
  | "NOT_APPLICABLE"
  | "EXCEPTED";

export type ComplianceCoverageConclusion = "COMPLETE" | "INCOMPLETE" | "MISSING";

export interface ComplianceAssessmentProvenance {
  readonly connectionId: string | null;
  readonly customerId: string | null;
  readonly awsAccountId: string | null;
  readonly sourceKind: "aws_trust_role" | "simulated_fixture" | null;
  readonly snapshotId: string | null;
  readonly snapshotSha256: string | null;
  readonly snapshotCollectedAt: string | null;
  readonly snapshotCoverageState: "complete" | "partial" | null;
}

export interface ComplianceCoverageEvidenceEntry {
  readonly region: string;
  readonly status: CoverageStatus;
  readonly itemsObserved: number;
  readonly pagesObserved: number;
  readonly errorCode: string | null;
}

export interface ComplianceCoverageEvidence {
  readonly collectorKey: string;
  readonly regionScope: "global" | "regional";
  readonly conclusion: ComplianceCoverageConclusion;
  readonly expectedRegions: readonly string[];
  readonly missingRegions: readonly string[];
  readonly entries: readonly ComplianceCoverageEvidenceEntry[];
}

export interface ComplianceFindingEvidence {
  readonly fingerprint: string;
  readonly resourceKey: string | null;
  readonly controlVersion: string;
  readonly severity: FindingSeverity;
  readonly status: PilotFinding["status"];
  readonly evaluatedAt: string;
}

export interface ComplianceControlEvidence {
  readonly applicableResourceCount: number;
  readonly coverage: readonly ComplianceCoverageEvidence[];
  readonly matchingFindings: readonly ComplianceFindingEvidence[];
}

export interface ComplianceControlResult {
  readonly controlKey: string;
  readonly controlVersion: string;
  readonly title: string;
  readonly description: string;
  readonly service: string;
  readonly severity: FindingSeverity;
  readonly scope: ComplianceControlScope;
  readonly status: ComplianceStatus;
  readonly reason: string;
  readonly remediation: string;
  readonly limitation: string;
  readonly frameworkMappings: readonly ComplianceFrameworkMapping[];
  readonly evidence: ComplianceControlEvidence;
}

export interface ComplianceAssessmentSummary {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly unknown: number;
  readonly notApplicable: number;
  readonly excepted: number;
  /** PASS + FAIL. UNKNOWN, NOT_APPLICABLE, and EXCEPTED are excluded. */
  readonly scoredControls: number;
  /** PASS / (PASS + FAIL), rounded to one decimal. Null when nothing is scorable. */
  readonly scorePercent: number | null;
}

export interface ComplianceAssessment {
  /** Stable for a given snapshot and catalog version; no wall-clock input is used. */
  readonly assessmentId: string;
  readonly catalog: {
    readonly key: string;
    readonly name: string;
    readonly version: string;
    readonly claimBoundary: string;
  };
  readonly provenance: ComplianceAssessmentProvenance;
  readonly summary: ComplianceAssessmentSummary;
  readonly results: readonly ComplianceControlResult[];
  readonly disclaimer: string;
}

const GLOBAL_INTEGRITY_COLLECTORS = new Set([
  "sutra.collection-deadline",
  "sutra.evidence-budget",
  "sutra.resource-budget",
  "sutra.snapshot-budget",
]);

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function expectedRegionalRegions(state: PilotState): string[] {
  const selection = state.connection?.enabledRegions ?? [];
  if (!(selection.length === 1 && selection[0] === ALL_ENABLED_AWS_REGIONS)) {
    return uniqueSorted(selection.filter((region) => region !== "global"));
  }

  return uniqueSorted(
    state.coverage
      .map((entry) => entry.region)
      .filter((region) => region !== "global"),
  );
}

function requirementEvidence(
  requirement: ComplianceCoverageRequirement,
  state: PilotState,
  regionalRegions: readonly string[],
): ComplianceCoverageEvidence {
  const expectedRegions =
    requirement.regionScope === "global" ? ["global"] : regionalRegions;
  const entries = state.coverage
    .filter((entry) => entry.collectorKey === requirement.collectorKey)
    .map((entry) => ({
      region: entry.region,
      status: entry.status,
      itemsObserved: entry.itemsObserved,
      pagesObserved: entry.pagesObserved,
      errorCode: entry.errorCode ?? null,
    }))
    .sort((left, right) => left.region.localeCompare(right.region));
  const observedRegions = new Set(entries.map((entry) => entry.region));
  const missingRegions = expectedRegions.filter((region) => !observedRegions.has(region));
  const hasUnsuccessfulEntry = entries.some((entry) => entry.status !== "succeeded");
  const conclusion: ComplianceCoverageConclusion =
    entries.length === 0 || expectedRegions.length === 0
      ? "MISSING"
      : missingRegions.length > 0 || hasUnsuccessfulEntry
        ? "INCOMPLETE"
        : "COMPLETE";

  return {
    collectorKey: requirement.collectorKey,
    regionScope: requirement.regionScope,
    conclusion,
    expectedRegions,
    missingRegions,
    entries,
  };
}

function findingEvidence(finding: PilotFinding): ComplianceFindingEvidence {
  return {
    fingerprint: finding.fingerprint,
    resourceKey: finding.resourceKey,
    controlVersion: finding.controlVersion,
    severity: finding.severity,
    status: finding.status,
    evaluatedAt: finding.evaluatedAt,
  };
}

function applicableResourceCount(
  control: ComplianceControlDefinition,
  state: PilotState,
  regionalRegions: readonly string[],
): number {
  if (control.scope === "account") return state.connection === null ? 0 : 1;
  if (control.scope === "regional") return regionalRegions.length;
  const applicableTypes = new Set(control.applicableResourceTypes);
  return state.resources.filter((resource) => applicableTypes.has(resource.resourceType)).length;
}

function hasGlobalIntegrityFailure(state: PilotState): boolean {
  if (state.activeSnapshot?.coverageState !== "complete") return true;
  return state.coverage.some(
    (entry) =>
      GLOBAL_INTEGRITY_COLLECTORS.has(entry.collectorKey) &&
      entry.status !== "succeeded",
  );
}

function controlResult(
  control: ComplianceControlDefinition,
  state: PilotState,
  regionalRegions: readonly string[],
): ComplianceControlResult {
  const coverage = control.requiredCoverage.map((requirement) =>
    requirementEvidence(requirement, state, regionalRegions),
  );
  const matching = state.findings
    .filter((finding) => finding.controlKey === control.key)
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  const failing = matching.filter(
    (finding) => finding.status === "open" || finding.status === "acknowledged",
  );
  const suppressed = matching.filter((finding) => finding.status === "suppressed");
  const resourceCount = applicableResourceCount(control, state, regionalRegions);
  const evidence: ComplianceControlEvidence = {
    applicableResourceCount: resourceCount,
    coverage,
    matchingFindings: matching.map(findingEvidence),
  };

  let status: ComplianceStatus;
  let reason: string;
  if (state.connection === null || state.activeSnapshot === null) {
    status = "UNKNOWN";
    reason = "No active immutable inventory snapshot is available for this AWS connection.";
  } else if (failing.length > 0) {
    status = "FAIL";
    reason = `${failing.length} active finding${failing.length === 1 ? "" : "s"} matched this control.`;
  } else if (suppressed.length > 0) {
    status = "EXCEPTED";
    reason =
      "All currently observed failures are suppressed in the finding workflow. Suppression is not a compliance certification; approval and expiry must be validated separately.";
  } else if (
    hasGlobalIntegrityFailure(state) ||
    coverage.some((item) => item.conclusion !== "COMPLETE")
  ) {
    status = "UNKNOWN";
    reason =
      "Required collector coverage is missing or incomplete, so the absence of an active finding cannot be treated as a pass.";
  } else if (control.scope === "resource" && resourceCount === 0) {
    status = "NOT_APPLICABLE";
    reason = "No resources of an applicable type were present in the covered snapshot.";
  } else {
    status = "PASS";
    reason =
      "Required collector coverage is complete and no active or suppressed finding matched this control in the snapshot.";
  }

  return {
    controlKey: control.key,
    controlVersion: control.version,
    title: control.title,
    description: control.description,
    service: control.service,
    severity: control.severity,
    scope: control.scope,
    status,
    reason,
    remediation: control.remediation,
    limitation: control.limitation,
    frameworkMappings: control.frameworkMappings,
    evidence,
  };
}

function assessmentProvenance(state: PilotState): ComplianceAssessmentProvenance {
  return {
    connectionId: state.connection?.id ?? null,
    customerId: state.connection?.customerId ?? null,
    awsAccountId: state.connection?.awsAccountId ?? null,
    sourceKind: state.connection?.sourceKind ?? null,
    snapshotId: state.activeSnapshot?.id ?? null,
    snapshotSha256: state.activeSnapshot?.snapshotSha256 ?? null,
    snapshotCollectedAt: state.activeSnapshot?.collectedAt ?? null,
    snapshotCoverageState: state.activeSnapshot?.coverageState ?? null,
  };
}

function assessmentSummary(
  results: readonly ComplianceControlResult[],
): ComplianceAssessmentSummary {
  const count = (status: ComplianceStatus) =>
    results.filter((result) => result.status === status).length;
  const pass = count("PASS");
  const fail = count("FAIL");
  const scoredControls = pass + fail;
  return {
    total: results.length,
    pass,
    fail,
    unknown: count("UNKNOWN"),
    notApplicable: count("NOT_APPLICABLE"),
    excepted: count("EXCEPTED"),
    scoredControls,
    scorePercent:
      scoredControls === 0 ? null : Math.round((pass / scoredControls) * 1_000) / 10,
  };
}

/**
 * Deterministically assesses one tenant-scoped PilotState. Only the active
 * snapshot projection and its own coverage are used; latest failed/partial run
 * coverage is intentionally not mixed into historical snapshot evidence.
 */
export function assessCompliance(
  state: PilotState,
  catalog: ComplianceControlCatalog = SUTRA_AWS_BASELINE,
): ComplianceAssessment {
  const regionalRegions = expectedRegionalRegions(state);
  const results = catalog.controls.map((control) =>
    controlResult(control, state, regionalRegions),
  );
  const snapshotIdentity = state.activeSnapshot?.id ?? "no-snapshot";
  return {
    assessmentId: `${snapshotIdentity}:${catalog.key}:${catalog.version}`,
    catalog: {
      key: catalog.key,
      name: catalog.name,
      version: catalog.version,
      claimBoundary: catalog.claimBoundary,
    },
    provenance: assessmentProvenance(state),
    summary: assessmentSummary(results),
    results,
    disclaimer: COMPLIANCE_ASSESSMENT_DISCLAIMER,
  };
}
