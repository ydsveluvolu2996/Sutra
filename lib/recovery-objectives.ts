export interface RecoveryObjectiveAssessment {
  readonly rpoTargetHours: number;
  readonly rtoTargetHours: number;
  readonly recoveryPointAgeSeconds: number;
  readonly recoveryDurationSeconds: number;
  readonly rpoMet: boolean;
  readonly rtoMet: boolean;
  readonly outcome: "passed" | "failed";
}

export function assessRecoveryObjectives(input: {
  readonly backupCreatedAt: string;
  readonly drillStartedAt: string;
  readonly drillCompletedAt: string;
  readonly rpoTargetHours?: number;
  readonly rtoTargetHours?: number;
}): RecoveryObjectiveAssessment {
  const created = Date.parse(input.backupCreatedAt);
  const started = Date.parse(input.drillStartedAt);
  const completed = Date.parse(input.drillCompletedAt);
  const rpoTargetHours = input.rpoTargetHours ?? 24;
  const rtoTargetHours = input.rtoTargetHours ?? 4;
  if (
    !Number.isFinite(created) ||
    !Number.isFinite(started) ||
    !Number.isFinite(completed) ||
    created > started ||
    completed < started ||
    !Number.isFinite(rpoTargetHours) ||
    !Number.isFinite(rtoTargetHours) ||
    rpoTargetHours <= 0 ||
    rtoTargetHours <= 0
  ) throw new Error("Recovery objective evidence is invalid");
  const recoveryPointAgeSeconds = Math.floor((started - created) / 1_000);
  const recoveryDurationSeconds = Math.ceil((completed - started) / 1_000);
  const rpoMet = recoveryPointAgeSeconds <= rpoTargetHours * 60 * 60;
  const rtoMet = recoveryDurationSeconds <= rtoTargetHours * 60 * 60;
  return {
    rpoTargetHours,
    rtoTargetHours,
    recoveryPointAgeSeconds,
    recoveryDurationSeconds,
    rpoMet,
    rtoMet,
    outcome: rpoMet && rtoMet ? "passed" : "failed",
  };
}
