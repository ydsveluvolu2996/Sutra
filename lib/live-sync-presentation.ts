import type {
  PilotConnection,
  PilotState,
} from "./pilot-types";

export type LiveSyncOutcomeKind =
  | "complete"
  | "partial"
  | "failed"
  | "in_progress"
  | "not_started"
  | "unknown";

export interface LiveSyncPresentation {
  readonly kind: LiveSyncOutcomeKind;
  readonly title: string;
  readonly message: string;
}

export interface TrustHealthPresentation {
  readonly label: string;
  readonly detail: string;
}

function projectionMessage(state: PilotState): string {
  return state.activeSnapshot === null
    ? "No authoritative CMDB projection was promoted."
    : "The previous complete CMDB projection remains active.";
}

/**
 * Describe only the server-persisted run returned by the sync endpoint. This
 * prevents a successful HTTP response from being presented as a complete CMDB
 * publication when AWS coverage was partial.
 */
export function describeLiveSyncResult(
  state: PilotState,
  runId: string,
): LiveSyncPresentation {
  const run = state.syncRuns.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    return {
      kind: "unknown",
      title: "Collection result unavailable",
      message: "Sutra could not confirm the persisted outcome. Refresh the workspace before relying on this run.",
    };
  }

  if (run.status === "succeeded" && run.coverageState === "complete") {
    return {
      kind: "complete",
      title: "Complete snapshot published",
      message: "AWS inventory completed with full configured coverage and the new CMDB projection is active.",
    };
  }

  if (run.status === "partial" && run.coverageState === "partial") {
    return {
      kind: "partial",
      title: "Partial collection recorded",
      message: `Some configured collectors did not complete. ${projectionMessage(state)} Review the run coverage, correct the AWS permission or service issue, and retry inventory.`,
    };
  }

  if (
    (run.status === "failed" || run.status === "cancelled") &&
    run.coverageState === "unknown"
  ) {
    return {
      kind: "failed",
      title: run.status === "cancelled" ? "Collection cancelled" : "Collection failed",
      message: `${projectionMessage(state)} Resolve the recorded collection error and retry inventory.`,
    };
  }

  if (
    (run.status === "queued" || run.status === "running") &&
    run.coverageState === "unknown"
  ) {
    return {
      kind: "in_progress",
      title: "Collection still running",
      message: `${projectionMessage(state)} Refresh the workspace to see the terminal result.`,
    };
  }

  return {
    kind: "unknown",
    title: "Collection result is inconsistent",
    message: `${projectionMessage(state)} Refresh the workspace before relying on this run.`,
  };
}

export function describeLatestCollection(state: PilotState): LiveSyncPresentation {
  const latest = state.syncRuns[0];
  if (latest === undefined) {
    return {
      kind: "not_started",
      title: "Not collected",
      message: "No AWS inventory run has been recorded for this connection.",
    };
  }
  return describeLiveSyncResult(state, latest.id);
}

export function describeTrustHealth(connection: PilotConnection): TrustHealthPresentation {
  switch (connection.status) {
    case "active":
      return {
        label: "Validated",
        detail: "The ExternalId trust boundary passed its last explicit validation.",
      };
    case "validating":
      return {
        label: "Validating",
        detail: "Sutra is proving the expected AWS identity and both negative ExternalId probes.",
      };
    case "needs_attention":
      return {
        label: "Revalidation required",
        detail: "The trust boundary must pass validation before another inventory run can start.",
      };
    case "disabled":
      return {
        label: "Disabled",
        detail: "This connection cannot validate trust or collect inventory.",
      };
    case "pending":
      return connection.roleArn === null
        ? {
          label: "Awaiting role",
          detail: "Register the customer-owned IAM role before trust validation.",
        }
        : {
          label: "Not validated",
          detail: "The role is registered but its ExternalId boundary has not passed validation.",
        };
  }
}

function sentence(value: string): string {
  const trimmed = value.trim().replace(/[.!?]+$/u, "");
  return trimmed.length === 0 ? "Sutra could not complete AWS inventory collection" : trimmed;
}

export function describeLiveSyncFailure(input: {
  readonly publicError: string;
  readonly trustValidatedThisAttempt: boolean;
  readonly existingTrustWasActive: boolean;
  readonly hasActiveSnapshot: boolean;
}): string {
  const failure = sentence(input.publicError);
  const projection = input.hasActiveSnapshot
    ? "The previous complete CMDB projection remains active."
    : "No authoritative CMDB projection was published."

  if (input.trustValidatedThisAttempt) {
    return `Trust validation passed, but inventory collection failed: ${failure}. ${projection} Retry inventory after resolving the collection issue; the customer role does not need to be recreated.`;
  }
  if (input.existingTrustWasActive) {
    return `Inventory collection failed: ${failure}. ${projection} Retry inventory after resolving the collection issue, or revalidate trust if AWS rejected the role session.`;
  }
  return `Trust validation failed: ${failure}. Inventory collection was not started.`;
}
