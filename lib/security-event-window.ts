import type { SecurityEventCollectionStatus } from "./security-event-types";

export const SECURITY_EVENT_MAX_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type SecurityEventWindowBasis =
  | "INITIAL_LOOKBACK"
  | "COMPLETE_CHECKPOINT_OVERLAP"
  | "INCOMPLETE_RETRY";

export interface SecurityEventWindowAttempt {
  readonly status: SecurityEventCollectionStatus;
  readonly windowStartMillis: number;
}

export interface ResolvedSecurityEventWindow {
  readonly startMillis: number;
  readonly endMillis: number;
  readonly requestedStartMillis: number;
  readonly basis: SecurityEventWindowBasis;
  readonly overlapMinutes: number;
  readonly gapTruncated: boolean;
}

export function resolveSecurityEventWindow(input: {
  readonly nowMillis: number;
  readonly lookbackHours: number;
  readonly overlapMinutes: number;
  readonly completeCheckpointEndMillis: number | null;
  readonly latestAttempt: SecurityEventWindowAttempt | null;
}): ResolvedSecurityEventWindow {
  if (
    !Number.isFinite(input.nowMillis) ||
    !Number.isSafeInteger(input.lookbackHours) || input.lookbackHours < 1 || input.lookbackHours > 24 ||
    !Number.isSafeInteger(input.overlapMinutes) || input.overlapMinutes < 0 || input.overlapMinutes > 60 ||
    (input.completeCheckpointEndMillis !== null && !Number.isFinite(input.completeCheckpointEndMillis)) ||
    (input.latestAttempt !== null && !Number.isFinite(input.latestAttempt.windowStartMillis))
  ) {
    throw new TypeError("Security-event collection checkpoint is invalid");
  }

  const overlapMillis = input.overlapMinutes * 60 * 1_000;
  const initialStart = input.nowMillis - input.lookbackHours * 60 * 60 * 1_000;
  const checkpointStart = input.completeCheckpointEndMillis === null
    ? initialStart
    : input.completeCheckpointEndMillis - overlapMillis;
  const incompleteAttempt = input.latestAttempt !== null &&
    (input.latestAttempt.status === "PARTIAL" || input.latestAttempt.status === "UNAVAILABLE")
    ? input.latestAttempt
    : null;
  const requestedStartMillis = incompleteAttempt === null
    ? checkpointStart
    : Math.min(checkpointStart, incompleteAttempt.windowStartMillis);
  const basis: SecurityEventWindowBasis = incompleteAttempt !== null
    ? "INCOMPLETE_RETRY"
    : input.completeCheckpointEndMillis === null
      ? "INITIAL_LOOKBACK"
      : "COMPLETE_CHECKPOINT_OVERLAP";
  const lowerBound = input.nowMillis - SECURITY_EVENT_MAX_WINDOW_MS;
  const startMillis = Math.min(
    input.nowMillis - 1_000,
    Math.max(lowerBound, requestedStartMillis),
  );

  return {
    startMillis,
    endMillis: input.nowMillis,
    requestedStartMillis,
    basis,
    overlapMinutes: input.overlapMinutes,
    gapTruncated: requestedStartMillis < lowerBound,
  };
}
