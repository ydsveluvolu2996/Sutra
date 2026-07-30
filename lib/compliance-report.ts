import { COMPLIANCE_FRAMEWORKS } from "./compliance-catalog.ts";
import { assessCompliance } from "./compliance-engine.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  applyComplianceExceptions,
  type ComplianceAssessmentWithExceptions,
  type ComplianceExceptionRecord,
} from "./compliance-exception-types.ts";
import type { PilotState } from "./pilot-types.ts";

export interface ComplianceReportCore {
  readonly schemaVersion: "sutra.compliance-report.v2";
  readonly assessment: ComplianceAssessmentWithExceptions;
  readonly frameworks: typeof COMPLIANCE_FRAMEWORKS;
  readonly exceptions: readonly ComplianceExceptionRecord[];
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

/**
 * Produces the one canonical compliance report identity used by display,
 * export, sign-off, and readiness. Keeping the hash construction in one place
 * prevents an approval for stale or differently evaluated evidence from being
 * presented as approval of the current report.
 */
export async function buildComplianceReport(
  state: PilotState,
  exceptions: readonly ComplianceExceptionRecord[],
  now = Date.now(),
): Promise<ComplianceReportCore & { readonly reportSha256: string }> {
  const reportCore: ComplianceReportCore = {
    schemaVersion: "sutra.compliance-report.v2",
    assessment: applyComplianceExceptions(assessCompliance(state), exceptions, now),
    frameworks: COMPLIANCE_FRAMEWORKS,
    exceptions,
  };
  return {
    ...reportCore,
    reportSha256: await sha256Hex(canonicalJson(reportCore)),
  };
}
