import type {
  PortfolioConnectionSummary,
  PortfolioCustomerSummary,
  PortfolioState,
} from "./portfolio-types";

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

function latestSnapshot(connections: readonly PortfolioConnectionSummary[]): string | null {
  return connections.reduce<string | null>((latest, connection) => {
    if (connection.latestSnapshotAt === null) return latest;
    return latest === null || connection.latestSnapshotAt > latest
      ? connection.latestSnapshotAt
      : latest;
  }, null);
}

/**
 * Local fixture customers are useful development tooling, but they must never
 * enter a hosted portfolio response if a fixture database was accidentally
 * restored or reused. Recompute every aggregate from the remaining live
 * connections so fixture rows cannot survive as inflated totals.
 */
export function portfolioForRuntime(
  portfolio: PortfolioState,
  allowSimulatedEvidence: boolean,
): PortfolioState {
  if (allowSimulatedEvidence) return portfolio;
  const customers = portfolio.customers.flatMap<PortfolioCustomerSummary>((customer) => {
    const connections = customer.connections.filter((connection) => connection.sourceKind !== "simulated_fixture");
    const hadSimulatedConnection = connections.length !== customer.connections.length;
    if (hadSimulatedConnection && connections.length === 0) return [];
    return [{
      ...customer,
      connectionCount: connections.length,
      resourceCount: connections.reduce((total, connection) => total + connection.resourceCount, 0),
      openFindingCount: connections.reduce((total, connection) => total + connection.openFindingCount, 0),
      latestSnapshotAt: latestSnapshot(connections),
      connections,
    }];
  });
  return {
    ...portfolio,
    totals: {
      customers: customers.length,
      connections: customers.reduce((total, customer) => total + customer.connectionCount, 0),
      resources: customers.reduce((total, customer) => total + customer.resourceCount, 0),
      openFindings: customers.reduce((total, customer) => total + customer.openFindingCount, 0),
    },
    customers,
  };
}

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
 * An explicit operating policy—not a posture score. Freshness is evaluated
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

  // The credential mechanism is read from sourceKind rather than assumed. This
  // previously fell through to trust-role wording for every non-fixture
  // connection, so once `aws_static_credentials` became representable an
  // access-key deployment asserted "Customer trust role" in its Source cell --
  // naming a role that was never deployed, for the one connection kind whose
  // permissions Sutra cannot state in advance.
  const staticKeys = connection.sourceKind === "aws_static_credentials";
  const mechanism = staticKeys ? "Customer IAM user access key" : "Customer trust role";
  const idleLabel = staticKeys ? "AWS access keys" : "AWS trust role";

  if (connection.latestSnapshotOrigin === "aws_live") {
    return { label: "Live AWS", detail: `${mechanism} · AWS API evidence` };
  }
  if (connection.latestSnapshotAt === null) {
    return { label: idleLabel, detail: "No evidence snapshot published" };
  }
  return { label: idleLabel, detail: "Stored snapshot origin unavailable" };
}
