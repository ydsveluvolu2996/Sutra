import type { PortfolioConnectionSummary } from "./portfolio-types";

export type SnapshotFreshness = "fresh" | "aging" | "stale" | "missing";

export interface SnapshotFreshnessView {
  readonly state: SnapshotFreshness;
  readonly label: string;
  readonly detail: string;
}

export interface ConnectionHealthView {
  readonly state: "active" | "pending" | "validating" | "needs_attention" | "disabled";
  readonly label: string;
  readonly detail: string;
}

const HOUR_MS = 60 * 60 * 1_000;
const FRESH_HOURS = 24;
const AGING_HOURS = 72;

function parsedTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function ageDetail(hours: number): string {
  if (hours < 1) return "Less than 1 hour old";
  if (hours < 24) return `${Math.floor(hours)}h old`;
  const days = Math.floor(hours / 24);
  return `${days}d old`;
}

/**
 * A small, explicit demo policy—not a posture score. Freshness is evaluated
 * against the server-provided portfolio measurement time so every operator
 * sees the same classification for the same response.
 */
export function snapshotFreshness(
  snapshotAt: string | null,
  measuredAt: string,
): SnapshotFreshnessView {
  const observed = parsedTimestamp(snapshotAt);
  const measured = parsedTimestamp(measuredAt);
  if (observed === null || measured === null) {
    return { state: "missing", label: "No baseline", detail: "No complete snapshot published" };
  }

  const ageHours = Math.max(0, (measured - observed) / HOUR_MS);
  if (ageHours <= FRESH_HOURS) {
    return { state: "fresh", label: "Fresh", detail: ageDetail(ageHours) };
  }
  if (ageHours <= AGING_HOURS) {
    return { state: "aging", label: "Aging", detail: ageDetail(ageHours) };
  }
  return { state: "stale", label: "Stale", detail: ageDetail(ageHours) };
}

export function connectionHealth(
  connection: PortfolioConnectionSummary,
  measuredAt: string,
): ConnectionHealthView {
  if (connection.status === "disabled") {
    return { state: "disabled", label: "Disabled", detail: "Collection is disabled" };
  }
  if (connection.status === "needs_attention") {
    return { state: "needs_attention", label: "Needs attention", detail: "Connection validation failed" };
  }
  if (connection.status === "pending") {
    return { state: "pending", label: "Pending", detail: "Trust role setup is incomplete" };
  }
  if (connection.status === "validating") {
    return { state: "validating", label: "Validating", detail: "Trust role validation is in progress" };
  }

  const freshness = snapshotFreshness(connection.latestSnapshotAt, measuredAt);
  if (freshness.state === "missing") {
    return { state: "needs_attention", label: "No baseline", detail: freshness.detail };
  }
  if (freshness.state === "stale") {
    return { state: "needs_attention", label: "Stale", detail: freshness.detail };
  }
  if (freshness.state === "aging") {
    return { state: "validating", label: "Aging", detail: freshness.detail };
  }
  return { state: "active", label: "Healthy", detail: freshness.detail };
}

export function evidenceSourceLabel(connection: PortfolioConnectionSummary): {
  readonly label: string;
  readonly detail: string;
} {
  if (connection.sourceKind === "simulated_fixture") {
    return {
      label: "Simulated fixture",
      detail: `${connection.fixtureId ?? "fixture"} · ${connection.fixtureVersion ?? "version unavailable"}`,
    };
  }
  if (connection.latestSnapshotOrigin === "aws_sandbox") {
    return { label: "Live AWS", detail: "Customer trust role · AWS API evidence" };
  }
  if (connection.latestSnapshotAt === null) {
    return { label: "AWS trust role", detail: "No evidence snapshot published" };
  }
  return { label: "AWS trust role", detail: "Stored snapshot origin unavailable" };
}
