import type { ComplianceAssessment, ComplianceControlResult } from "./compliance-engine";

export const COMPLIANCE_EXCEPTION_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "revoked",
] as const;

export type ComplianceExceptionStatus = (typeof COMPLIANCE_EXCEPTION_STATUSES)[number];

export interface ComplianceExceptionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly controlKey: string;
  readonly findingFingerprint: string;
  readonly status: ComplianceExceptionStatus;
  readonly effectiveStatus: ComplianceExceptionStatus | "expired";
  readonly ownerUserId: string;
  readonly ownerDisplayName: string;
  readonly requestedBy: string;
  readonly requestedByDisplayName: string;
  readonly reviewedBy: string | null;
  readonly reviewedByDisplayName: string | null;
  readonly rationale: string;
  readonly compensatingControl: string;
  readonly reviewNote: string | null;
  readonly expiresAt: string;
  readonly requestedAt: string;
  readonly reviewedAt: string | null;
  readonly revokedAt: string | null;
  readonly updatedAt: string;
}

export interface ComplianceExceptionActivity {
  readonly id: string;
  readonly exceptionId: string;
  readonly action: "requested" | "approved" | "rejected" | "revoked";
  readonly actorId: string;
  readonly actorDisplayName: string;
  readonly note: string | null;
  readonly occurredAt: string;
}

export interface ComplianceExceptionWithActivity extends ComplianceExceptionRecord {
  readonly activity: readonly ComplianceExceptionActivity[];
}

export interface ComplianceExceptionApplication {
  readonly exceptionId: string;
  readonly findingFingerprint: string;
  readonly ownerUserId: string;
  readonly compensatingControl: string;
  readonly expiresAt: string;
  readonly approvedBy: string;
}

export interface ComplianceControlResultWithException extends ComplianceControlResult {
  readonly approvedExceptions: readonly ComplianceExceptionApplication[];
}

export interface ComplianceAssessmentWithExceptions extends Omit<ComplianceAssessment, "results"> {
  readonly results: readonly ComplianceControlResultWithException[];
}

export function isEffectiveApprovedException(
  record: Pick<ComplianceExceptionRecord, "status" | "expiresAt">,
  now = Date.now(),
): boolean {
  return record.status === "approved" && Date.parse(record.expiresAt) > now;
}

export function applyComplianceExceptions(
  assessment: ComplianceAssessment,
  exceptions: readonly ComplianceExceptionRecord[],
  now = Date.now(),
): ComplianceAssessmentWithExceptions {
  const approved = exceptions.filter((record) => isEffectiveApprovedException(record, now));
  const results = assessment.results.map((result): ComplianceControlResultWithException => {
    const activeFailureFingerprints = result.evidence.matchingFindings
      .filter((finding) => finding.status === "open" || finding.status === "acknowledged" || finding.status === "suppressed")
      .map((finding) => finding.fingerprint);
    const applicable = approved.filter((record) =>
      record.controlKey === result.controlKey && activeFailureFingerprints.includes(record.findingFingerprint));
    const covered = new Set(applicable.map((record) => record.findingFingerprint));
    const allCovered = activeFailureFingerprints.length > 0 && activeFailureFingerprints.every((fingerprint) => covered.has(fingerprint));
    const applications = applicable.map((record): ComplianceExceptionApplication => ({
      exceptionId: record.id,
      findingFingerprint: record.findingFingerprint,
      ownerUserId: record.ownerUserId,
      compensatingControl: record.compensatingControl,
      expiresAt: record.expiresAt,
      approvedBy: record.reviewedBy ?? "unknown",
    }));
    if (!allCovered) return { ...result, approvedExceptions: applications };
    return {
      ...result,
      status: "EXCEPTED",
      reason: `${applications.length} approved, unexpired exception${applications.length === 1 ? "" : "s"} cover every currently observed failure. Exceptions remain outside the tested pass score.`,
      approvedExceptions: applications,
    };
  });
  const count = (status: ComplianceControlResult["status"]) => results.filter((result) => result.status === status).length;
  const pass = count("PASS");
  const fail = count("FAIL");
  const scoredControls = pass + fail;
  return {
    ...assessment,
    summary: {
      total: results.length,
      pass,
      fail,
      unknown: count("UNKNOWN"),
      notApplicable: count("NOT_APPLICABLE"),
      excepted: count("EXCEPTED"),
      scoredControls,
      scorePercent: scoredControls === 0 ? null : Math.round((pass / scoredControls) * 1_000) / 10,
    },
    results,
  };
}
