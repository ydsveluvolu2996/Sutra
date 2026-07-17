export type FleetAgentState = "online" | "offline" | "revoked";
export type FleetClusterState = "online" | "degraded" | "offline" | "not_enrolled";
export type FleetModuleState = "AVAILABLE" | "DEGRADED" | "NOT_CONFIGURED" | "UNKNOWN";

export interface FleetAgentInput {
  readonly agentId: string;
  readonly clusterId: string;
  readonly state: FleetAgentState;
  readonly agentVersion: string;
  readonly modules: Readonly<Record<string, string>>;
  readonly lastHeartbeatAt: string | null;
  readonly lastScanAt: string | null;
}

export interface FleetClusterInput {
  readonly id: string;
  readonly name: string;
  readonly distribution: string | null;
  readonly version: string | null;
  readonly status: "active" | "disabled";
}

export interface FleetClusterHealth {
  readonly clusterId: string;
  readonly clusterName: string;
  readonly distribution: string | null;
  readonly version: string | null;
  readonly state: FleetClusterState;
  readonly agentCount: number;
  readonly onlineAgentCount: number;
  readonly modules: Readonly<Record<string, FleetModuleState>>;
  readonly lastHeartbeatAt: string | null;
  readonly lastScanAt: string | null;
}

export interface FleetHealthSummary {
  readonly schema: "sutra.kubernetes-fleet-health.v1";
  readonly clusters: readonly FleetClusterHealth[];
  readonly totals: {
    readonly clusters: number;
    readonly online: number;
    readonly degraded: number;
    readonly offline: number;
    readonly notEnrolled: number;
    readonly enrolledAgents: number;
    readonly onlineAgents: number;
  };
  readonly disclaimer: string;
}

const MODULE_STATES: readonly FleetModuleState[] = [
  "AVAILABLE", "DEGRADED", "NOT_CONFIGURED", "UNKNOWN",
];

const FLEET_DISCLAIMER =
  "Deployment health reflects the most recent signed agent heartbeats only; " +
  "a cluster without a heartbeat is shown as not enrolled or offline, never assumed healthy.";

function normalizeModuleState(value: string | undefined): FleetModuleState {
  return value !== undefined && (MODULE_STATES as readonly string[]).includes(value)
    ? value as FleetModuleState
    : "UNKNOWN";
}

// A cluster's per-module state is the worst observed across its online agents,
// so a single degraded node never hides behind a healthy sibling.
function worstModuleState(states: readonly FleetModuleState[]): FleetModuleState {
  if (states.includes("DEGRADED")) return "DEGRADED";
  if (states.includes("UNKNOWN")) return "UNKNOWN";
  if (states.includes("AVAILABLE")) return "AVAILABLE";
  return "NOT_CONFIGURED";
}

function laterTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function buildKubernetesFleetHealth(input: {
  readonly clusters: readonly FleetClusterInput[];
  readonly agents: readonly FleetAgentInput[];
}): FleetHealthSummary {
  const agentsByCluster = new Map<string, FleetAgentInput[]>();
  for (const agent of input.agents) {
    const bucket = agentsByCluster.get(agent.clusterId);
    if (bucket === undefined) agentsByCluster.set(agent.clusterId, [agent]);
    else bucket.push(agent);
  }

  const clusters = input.clusters
    .filter((cluster) => cluster.status === "active")
    .map((cluster): FleetClusterHealth => {
      const agents = agentsByCluster.get(cluster.id) ?? [];
      const liveAgents = agents.filter((agent) => agent.state !== "revoked");
      const onlineAgents = agents.filter((agent) => agent.state === "online");

      const moduleNames = [...new Set(
        onlineAgents.flatMap((agent) => Object.keys(agent.modules)),
      )].sort((left, right) => left.localeCompare(right, "en-US"));
      const modules: Record<string, FleetModuleState> = {};
      for (const name of moduleNames) {
        modules[name] = worstModuleState(
          onlineAgents.map((agent) => normalizeModuleState(agent.modules[name])),
        );
      }

      let state: FleetClusterState;
      if (liveAgents.length === 0) {
        state = "not_enrolled";
      } else if (onlineAgents.length === 0) {
        state = "offline";
      } else if (
        onlineAgents.length < liveAgents.length ||
        Object.values(modules).includes("DEGRADED")
      ) {
        state = "degraded";
      } else {
        state = "online";
      }

      return {
        clusterId: cluster.id,
        clusterName: cluster.name,
        distribution: cluster.distribution,
        version: cluster.version,
        state,
        agentCount: liveAgents.length,
        onlineAgentCount: onlineAgents.length,
        modules,
        lastHeartbeatAt: agents.reduce<string | null>(
          (latest, agent) => laterTimestamp(latest, agent.lastHeartbeatAt), null),
        lastScanAt: agents.reduce<string | null>(
          (latest, agent) => laterTimestamp(latest, agent.lastScanAt), null),
      };
    })
    .sort((left, right) =>
      left.clusterName.localeCompare(right.clusterName, "en-US") ||
      left.clusterId.localeCompare(right.clusterId, "en-US"));

  return {
    schema: "sutra.kubernetes-fleet-health.v1",
    clusters,
    totals: {
      clusters: clusters.length,
      online: clusters.filter((cluster) => cluster.state === "online").length,
      degraded: clusters.filter((cluster) => cluster.state === "degraded").length,
      offline: clusters.filter((cluster) => cluster.state === "offline").length,
      notEnrolled: clusters.filter((cluster) => cluster.state === "not_enrolled").length,
      enrolledAgents: clusters.reduce((sum, cluster) => sum + cluster.agentCount, 0),
      onlineAgents: clusters.reduce((sum, cluster) => sum + cluster.onlineAgentCount, 0),
    },
    disclaimer: FLEET_DISCLAIMER,
  };
}
