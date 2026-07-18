// Pure planner for agentless snapshot scanning (step 1 of
// docs/agentless-snapshot-scanning-design.md). Given a set of discovered EBS
// volumes and a policy, it produces a DETERMINISTIC, reviewable plan of the
// snapshot -> copy -> scan -> teardown steps that a disposable scanner would
// run — with per-volume in-scope/skip decisions (never silently dropped), a
// KMS re-encryption step when a scan-account key is provided, a guaranteed
// teardown list, and a bounded concurrency wave estimate. It executes NOTHING
// and touches no AWS; it is the plan a human/orchestrator reviews before any
// snapshot is created, mirroring the plan/apply split used elsewhere.

export interface AgentlessVolume {
  readonly volumeId: string;
  readonly region: string;
  readonly sizeGiB: number;
  readonly encrypted: boolean;
  readonly instanceId?: string | null;
  readonly attached?: boolean;
  /** Tags used for opt-in scoping (e.g. sutra-agentless=true). */
  readonly tags?: Readonly<Record<string, string>>;
}

export interface AgentlessScanPolicy {
  /** Only volumes carrying every one of these tag key=value pairs are in scope. */
  readonly requiredTags?: Readonly<Record<string, string>>;
  readonly includeUnattached?: boolean;
  readonly maxConcurrentScans?: number;
  readonly snapshotTtlHours?: number;
  /** Scanners the disposable worker will run against the mounted volume. */
  readonly scanners?: readonly ("vuln" | "secret" | "sbom" | "malware")[];
}

export type AgentlessStepKind =
  | "create-snapshot" | "copy-snapshot-kms" | "create-scan-volume"
  | "scan" | "delete-scan-volume" | "delete-copied-snapshot" | "delete-source-snapshot";

export interface AgentlessStep {
  readonly kind: AgentlessStepKind;
  readonly detail: string;
  /** True when this step tears a resource down (must run even on scan failure). */
  readonly teardown: boolean;
}

export interface AgentlessVolumePlan {
  readonly volumeId: string;
  readonly region: string;
  readonly sizeGiB: number;
  readonly steps: readonly AgentlessStep[];
}

export interface AgentlessSkippedVolume {
  readonly volumeId: string;
  readonly reason: "missing-required-tag" | "unattached-excluded";
}

export interface AgentlessScanPlan {
  readonly schema: "sutra.aws-agentless-scan-plan.v1";
  readonly mode: "plan";
  readonly scanAccountId: string;
  readonly kmsReencrypt: boolean;
  readonly scanners: readonly string[];
  readonly volumes: readonly AgentlessVolumePlan[];
  readonly skipped: readonly AgentlessSkippedVolume[];
  readonly summary: {
    readonly inScope: number;
    readonly skipped: number;
    readonly snapshots: number;
    readonly teardownSteps: number;
    readonly concurrencyWaves: number;
    readonly snapshotTtlHours: number;
  };
  readonly disclaimer: string;
}

const PLAN_DISCLAIMER =
  "Agentless scan PLAN only — no AWS API is called and no snapshot is created. " +
  "Every plan is reviewed before apply. Snapshots/volumes are TTL-bounded and " +
  "torn down unconditionally (even on scan failure); scan findings are ingested " +
  "metadata-only and no customer file contents transit the control plane.";

const DEFAULT_SCANNERS: readonly NonNullable<AgentlessScanPolicy["scanners"]>[number][] = ["vuln", "secret", "sbom"];

function hasRequiredTags(volume: AgentlessVolume, required: Readonly<Record<string, string>> | undefined): boolean {
  if (required === undefined) return true;
  const tags = volume.tags ?? {};
  return Object.entries(required).every(([key, value]) => tags[key] === value);
}

export function buildAgentlessScanPlan(input: {
  readonly volumes: readonly AgentlessVolume[];
  readonly policy?: AgentlessScanPolicy;
  readonly scanAccountId: string;
  readonly kmsKeyArn?: string | null;
}): AgentlessScanPlan {
  const policy = input.policy ?? {};
  const includeUnattached = policy.includeUnattached ?? false;
  const maxConcurrent = Math.max(1, Math.min(64, policy.maxConcurrentScans ?? 4));
  const snapshotTtlHours = Math.max(1, Math.min(168, policy.snapshotTtlHours ?? 24));
  const scanners = [...new Set(policy.scanners ?? DEFAULT_SCANNERS)].sort();
  const kmsReencrypt = typeof input.kmsKeyArn === "string" && input.kmsKeyArn.trim().length > 0;

  const skipped: AgentlessSkippedVolume[] = [];
  const inScope: AgentlessVolume[] = [];
  for (const volume of input.volumes) {
    if (!hasRequiredTags(volume, policy.requiredTags)) {
      skipped.push({ volumeId: volume.volumeId, reason: "missing-required-tag" });
      continue;
    }
    if (volume.attached === false && !includeUnattached) {
      skipped.push({ volumeId: volume.volumeId, reason: "unattached-excluded" });
      continue;
    }
    inScope.push(volume);
  }
  inScope.sort((left, right) => left.volumeId.localeCompare(right.volumeId, "en-US"));

  const volumes = inScope.map((volume): AgentlessVolumePlan => {
    const steps: AgentlessStep[] = [
      { kind: "create-snapshot", detail: `Point-in-time snapshot of ${volume.volumeId} (${volume.region}), tagged sutra-agentless=true, TTL ${snapshotTtlHours}h`, teardown: false },
    ];
    if (kmsReencrypt) {
      steps.push({ kind: "copy-snapshot-kms", detail: `Re-encrypt the snapshot with the Sutra scan-account KMS key into ${input.scanAccountId}`, teardown: false });
    }
    steps.push(
      { kind: "create-scan-volume", detail: `Create a read-only volume from the snapshot in the disposable scanner (${input.scanAccountId})`, teardown: false },
      { kind: "scan", detail: `Run ${scanners.join(", ")} against the mounted read-only volume; emit metadata-only findings`, teardown: false },
      { kind: "delete-scan-volume", detail: "Delete the scan volume", teardown: true },
      ...(kmsReencrypt ? [{ kind: "delete-copied-snapshot" as const, detail: "Delete the re-encrypted copied snapshot", teardown: true }] : []),
      { kind: "delete-source-snapshot", detail: `Delete the source snapshot of ${volume.volumeId}`, teardown: true },
    );
    return { volumeId: volume.volumeId, region: volume.region, sizeGiB: volume.sizeGiB, steps };
  });

  const teardownSteps = volumes.reduce((sum, volume) => sum + volume.steps.filter((step) => step.teardown).length, 0);

  return {
    schema: "sutra.aws-agentless-scan-plan.v1",
    mode: "plan",
    scanAccountId: input.scanAccountId,
    kmsReencrypt,
    scanners,
    volumes,
    skipped: skipped.sort((left, right) => left.volumeId.localeCompare(right.volumeId, "en-US")),
    summary: {
      inScope: volumes.length,
      skipped: skipped.length,
      snapshots: volumes.length,
      teardownSteps,
      concurrencyWaves: Math.ceil(volumes.length / maxConcurrent),
      snapshotTtlHours,
    },
    disclaimer: PLAN_DISCLAIMER,
  };
}
