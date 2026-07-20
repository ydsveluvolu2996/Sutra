/**
 * Pure, deterministic OS patch-COMPLIANCE posture over collected read-only SSM
 * facts. Sutra never patches a host: it reads patch state (AWS SSM
 * DescribeInstanceInformation / DescribeInstancePatchStates /
 * DescribeInstancePatches) and GENERATES a remediation runbook the customer runs
 * themselves — mirroring the generate-only Kyverno/kubectl model where manifests
 * are produced but never applied.
 *
 * Evidence-honesty rules (never relaxed):
 * - An instance is "compliant" ONLY when SSM reported a patch state with zero
 *   missing and zero failed patches. An instance with NO collected SSM patch
 *   data (agent not installed / not SSM-managed / never scanned) is
 *   "not-assessed" and is NEVER counted or shown as compliant. The reason is
 *   always disclosed.
 * - Counts are echoed straight from the collected SSM facts. A missing count is
 *   `null` (disclosed) rather than fabricated as `0`.
 * - A remediation runbook is generated ONLY for a genuinely non-compliant
 *   instance (SSM-assessed with missing/failed patches). The runbook is the
 *   exact command text for the CUSTOMER to run; Sutra does not execute it.
 * - The predicate that makes an instance compliant / non-compliant is applied
 *   here (deterministic and testable); the adapter only shapes collected facts.
 */
export type PatchComplianceStatus = "compliant" | "non-compliant" | "not-assessed";

export interface PatchDetail {
  readonly title: string | null;
  readonly kbId: string | null;
  readonly classification: string | null;
  readonly severity: string | null;
}

export interface PatchStateFacts {
  /** True when SSM reports the instance as a managed node. */
  readonly managed: boolean;
  /** True when a DescribeInstancePatchStates entry existed for the instance. */
  readonly patchStateAvailable: boolean;
  readonly baselineId: string | null;
  readonly operation: string | null;
  readonly lastScanAt: string | null;
  readonly installedCount: number | null;
  readonly missingCount: number | null;
  readonly failedCount: number | null;
  readonly notApplicableCount: number | null;
  readonly criticalMissingCount: number | null;
  readonly securityMissingCount: number | null;
  readonly otherNonCompliantCount: number | null;
  readonly missingPatches: readonly PatchDetail[];
}

export interface PatchInstanceInput {
  readonly resourceKey: string;
  readonly instanceId: string;
  readonly name: string | null;
  readonly region: string | null;
  /** EC2 lifecycle state (running / stopped), used only for display context. */
  readonly instanceState: string | null;
  readonly platform: string | null;
  /** null => no SSM patch-state facts were collected for this instance. */
  readonly patch: PatchStateFacts | null;
}

export interface PatchPostureInput {
  readonly instances: readonly PatchInstanceInput[];
}

export interface PatchInstancePosture {
  readonly resourceKey: string;
  readonly instanceId: string;
  readonly name: string | null;
  readonly region: string | null;
  readonly instanceState: string | null;
  readonly platform: string | null;
  readonly complianceStatus: PatchComplianceStatus;
  /** True only when SSM actually reported a patch state for this instance. */
  readonly assessed: boolean;
  readonly managed: boolean;
  readonly missingCount: number | null;
  readonly criticalMissingCount: number | null;
  readonly securityMissingCount: number | null;
  readonly failedCount: number | null;
  readonly installedCount: number | null;
  readonly baselineId: string | null;
  readonly lastScanAt: string | null;
  /** Discloses why the instance is compliant, non-compliant, or not-assessed. */
  readonly statusReason: string;
  readonly missingPatches: readonly PatchDetail[];
}

export interface PatchRemediationRunbook {
  readonly instanceId: string;
  readonly name: string | null;
  readonly region: string | null;
  readonly criticalMissingCount: number | null;
  readonly missingCount: number | null;
  /** The exact command for the CUSTOMER to run. Sutra never executes it. */
  readonly command: string;
  /** A read-only command to confirm the result afterwards. */
  readonly verifyCommand: string;
  readonly steps: readonly string[];
  readonly generatedNotExecutedNotice: string;
}

export interface PatchPostureSummary {
  readonly fleetSize: number;
  readonly compliant: number;
  readonly nonCompliant: number;
  /** unmanaged + managedNotScanned — every instance SSM could not assess. */
  readonly notAssessed: number;
  /** No SSM patch data at all (agent not installed / not SSM-managed). */
  readonly unmanaged: number;
  /** SSM-managed but no patch scan has been reported. */
  readonly managedNotScanned: number;
  /** compliant + nonCompliant. */
  readonly assessed: number;
  readonly criticalMissingTotal: number;
  readonly securityMissingTotal: number;
  /** assessed / fleetSize as a percentage; null when the fleet is empty. */
  readonly assessmentCoveragePercent: number | null;
}

export interface PatchPostureReport {
  readonly schema: "sutra.patch-posture.v1";
  readonly instances: readonly PatchInstancePosture[];
  readonly runbooks: readonly PatchRemediationRunbook[];
  readonly summary: PatchPostureSummary;
  readonly limitations: readonly string[];
  readonly disclaimer: string;
  readonly remediationNotice: string;
}

const REASON_COMPLIANT = "SSM_REPORTED_ZERO_MISSING_AND_ZERO_FAILED_PATCHES";
const REASON_NON_COMPLIANT = "SSM_REPORTED_MISSING_OR_FAILED_PATCHES";
const REASON_UNMANAGED =
  "NO_SSM_PATCH_DATA_INSTANCE_NOT_SSM_MANAGED_OR_AGENT_NOT_INSTALLED_NOT_ASSESSED_NEVER_ASSUMED_COMPLIANT";
const REASON_MANAGED_NOT_SCANNED =
  "SSM_MANAGED_BUT_NO_PATCH_STATE_REPORTED_RUN_A_PATCH_SCAN_NOT_ASSESSED_NEVER_ASSUMED_COMPLIANT";

export const PATCH_POSTURE_GENERATED_NOT_EXECUTED_NOTICE =
  "Sutra generates this remediation for you to run in your own change process. " +
  "Sutra is strictly read-only: it collects patch-compliance state and never " +
  "installs a patch or runs any command in your environment.";

export const PATCH_POSTURE_DISCLAIMER =
  "Patch posture is derived only from the read-only AWS SSM patch state Sutra " +
  "collected. An instance is shown compliant ONLY when SSM reported zero missing " +
  "and zero failed patches. Instances with no collected SSM patch data (agent " +
  "not installed, not SSM-managed, or never scanned) are reported as " +
  "not-assessed and are never counted or implied compliant. Remediation runbooks " +
  "are generated for you to run yourself — Sutra never executes them.";

const LIMITATIONS: readonly string[] = [
  "COMPLIANCE_IS_DERIVED_ONLY_FROM_COLLECTED_SSM_PATCH_STATE_NEVER_INFERRED",
  "INSTANCES_WITHOUT_SSM_PATCH_DATA_ARE_NOT_ASSESSED_NEVER_ASSUMED_COMPLIANT",
  "MISSING_PATCH_DETAIL_IS_BOUNDED_AND_MAY_BE_TRUNCATED_FOR_LARGE_INSTANCES",
  "REMEDIATION_RUNBOOKS_ARE_GENERATED_FOR_THE_CUSTOMER_TO_RUN_SUTRA_NEVER_EXECUTES_THEM",
];

function nonNegative(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Assess a single instance against the honesty rules. */
function assessInstance(instance: PatchInstanceInput): PatchInstancePosture {
  const patch = instance.patch;
  const base = {
    resourceKey: instance.resourceKey,
    instanceId: instance.instanceId,
    name: instance.name,
    region: instance.region,
    instanceState: instance.instanceState,
    platform: instance.platform,
    missingPatches: patch?.missingPatches ?? [],
  };

  // No SSM patch data at all — unmanaged / not assessed. Never compliant.
  if (patch === null) {
    return {
      ...base,
      complianceStatus: "not-assessed",
      assessed: false,
      managed: false,
      missingCount: null,
      criticalMissingCount: null,
      securityMissingCount: null,
      failedCount: null,
      installedCount: null,
      baselineId: null,
      lastScanAt: null,
      statusReason: REASON_UNMANAGED,
      missingPatches: [],
    };
  }

  // SSM-managed but no patch state reported yet — not assessed. Never compliant.
  if (!patch.patchStateAvailable) {
    return {
      ...base,
      complianceStatus: "not-assessed",
      assessed: false,
      managed: patch.managed,
      missingCount: patch.missingCount,
      criticalMissingCount: patch.criticalMissingCount,
      securityMissingCount: patch.securityMissingCount,
      failedCount: patch.failedCount,
      installedCount: patch.installedCount,
      baselineId: patch.baselineId,
      lastScanAt: patch.lastScanAt,
      statusReason: REASON_MANAGED_NOT_SCANNED,
      missingPatches: [],
    };
  }

  const missing = nonNegative(patch.missingCount);
  const failed = nonNegative(patch.failedCount);
  const compliant = missing === 0 && failed === 0;
  return {
    ...base,
    complianceStatus: compliant ? "compliant" : "non-compliant",
    assessed: true,
    managed: patch.managed,
    missingCount: patch.missingCount,
    criticalMissingCount: patch.criticalMissingCount,
    securityMissingCount: patch.securityMissingCount,
    failedCount: patch.failedCount,
    installedCount: patch.installedCount,
    baselineId: patch.baselineId,
    lastScanAt: patch.lastScanAt,
    statusReason: compliant ? REASON_COMPLIANT : REASON_NON_COMPLIANT,
    missingPatches: compliant ? [] : (patch.missingPatches ?? []),
  };
}

/**
 * The exact, copy-paste command the CUSTOMER runs to remediate. It uses the
 * AWS-managed AWS-RunPatchBaseline document via `ssm send-command`. Sutra
 * generates it as text only and never runs it.
 */
function generateRunbook(posture: PatchInstancePosture): PatchRemediationRunbook {
  const region = posture.region ?? "<region>";
  const command = [
    "aws ssm send-command \\",
    '  --document-name "AWS-RunPatchBaseline" \\',
    '  --document-version "$LATEST" \\',
    `  --targets "Key=InstanceIds,Values=${posture.instanceId}" \\`,
    '  --parameters "Operation=Install,RebootOption=RebootIfNeeded" \\',
    '  --comment "Sutra-generated patch remediation - review before running" \\',
    `  --region ${region}`,
  ].join("\n");
  const verifyCommand =
    `aws ssm describe-instance-patch-states --instance-ids ${posture.instanceId} --region ${region}`;
  return {
    instanceId: posture.instanceId,
    name: posture.name,
    region: posture.region,
    criticalMissingCount: posture.criticalMissingCount,
    missingCount: posture.missingCount,
    command,
    verifyCommand,
    steps: [
      "Review the missing patches and confirm the change in your maintenance window.",
      "Back up the instance (EBS snapshot or AMI) before installing patches.",
      "Run the generated command yourself from an operator session with SSM write access.",
      "Confirm the result with the verify command; a reboot may be required for some patches.",
    ],
    generatedNotExecutedNotice: PATCH_POSTURE_GENERATED_NOT_EXECUTED_NOTICE,
  };
}

const STATUS_RANK: Readonly<Record<PatchComplianceStatus, number>> = {
  "non-compliant": 0,
  "not-assessed": 1,
  compliant: 2,
};

export function buildPatchPosture(input: PatchPostureInput): PatchPostureReport {
  const instances = input.instances.map(assessInstance);
  instances.sort(
    (left, right) =>
      STATUS_RANK[left.complianceStatus] - STATUS_RANK[right.complianceStatus] ||
      nonNegative(right.criticalMissingCount) - nonNegative(left.criticalMissingCount) ||
      left.instanceId.localeCompare(right.instanceId, "en-US"),
  );

  let compliant = 0;
  let nonCompliant = 0;
  let unmanaged = 0;
  let managedNotScanned = 0;
  let criticalMissingTotal = 0;
  let securityMissingTotal = 0;
  const runbooks: PatchRemediationRunbook[] = [];

  for (const posture of instances) {
    if (posture.complianceStatus === "compliant") {
      compliant += 1;
    } else if (posture.complianceStatus === "non-compliant") {
      nonCompliant += 1;
      criticalMissingTotal += nonNegative(posture.criticalMissingCount);
      securityMissingTotal += nonNegative(posture.securityMissingCount);
      // Runbook generated ONLY for genuinely non-compliant instances.
      runbooks.push(generateRunbook(posture));
    } else if (posture.managed) {
      managedNotScanned += 1;
    } else {
      unmanaged += 1;
    }
  }

  const fleetSize = instances.length;
  const assessed = compliant + nonCompliant;
  const notAssessed = unmanaged + managedNotScanned;

  return {
    schema: "sutra.patch-posture.v1",
    instances,
    runbooks,
    summary: {
      fleetSize,
      compliant,
      nonCompliant,
      notAssessed,
      unmanaged,
      managedNotScanned,
      assessed,
      criticalMissingTotal,
      securityMissingTotal,
      assessmentCoveragePercent: fleetSize === 0 ? null : Math.round((assessed / fleetSize) * 100),
    },
    limitations: LIMITATIONS,
    disclaimer: PATCH_POSTURE_DISCLAIMER,
    remediationNotice: PATCH_POSTURE_GENERATED_NOT_EXECUTED_NOTICE,
  };
}
