// Pure client-side contract for the operator-driven Kubernetes agent
// revocation action (POST /api/v1/kubernetes/agents/{agentId}/revoke).
//
// The route is session-gated (requireApiSession + assertSessionCapability on the
// customer resolved from the connection), accepts EXACTLY two body keys
// (connectionId, clusterId) and takes the agent from the path. Revocation is
// security-consequential and effectively irreversible for that credential: the
// stored digest is replaced with an unguessable value, so the agent's current
// and previous tokens both stop authenticating and it cannot report again until
// it is re-enrolled. This module keeps the request shape, the confirmation copy
// and the optimistic list transition deterministic and unit-testable, with no
// React and no network access. It never handles token or credential material —
// the revoke response carries only { agentId, status }.

/** Identifier shapes the route validates server-side; mirrored so the UI cannot send a request that is guaranteed to be rejected. */
export const AGENT_REVOCATION_AGENT_ID = /^kagent_[a-f0-9]{32}$/u;
export const AGENT_REVOCATION_CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
export const AGENT_REVOCATION_CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;

export type ManagedAgentState = "online" | "offline" | "revoked";

/** The subset of the agent deployment-health record the management surface needs. */
export interface ManagedAgent {
  readonly agentId: string;
  readonly clusterId: string;
  readonly nodeName: string | null;
  readonly state: ManagedAgentState;
  readonly agentVersion: string;
  readonly deployment: {
    readonly namespace: string;
    readonly podName: string;
    readonly startedAt: string;
  } | null;
  readonly lastHeartbeatAt: string | null;
  readonly lastScanAt: string | null;
}

export interface AgentRevocationTarget {
  readonly agentId: string;
  readonly connectionId: string;
  readonly clusterId: string;
  readonly clusterName: string;
}

export interface AgentRevocationRequest {
  readonly path: string;
  readonly body: { readonly connectionId: string; readonly clusterId: string };
}

export class AgentRevocationInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AgentRevocationInputError";
  }
}

/** A short, stable human label for one agent — pod identity when reported, otherwise the agent id. */
export function agentDisplayName(agent: Pick<ManagedAgent, "agentId" | "deployment" | "nodeName">): string {
  if (agent.deployment !== null) return `${agent.deployment.namespace}/${agent.deployment.podName}`;
  if (agent.nodeName !== null && agent.nodeName.length > 0) return `node ${agent.nodeName}`;
  return agent.agentId;
}

/** Accessible name for the per-agent revoke control: always names the specific agent AND cluster. */
export function agentRevocationActionLabel(
  agent: Pick<ManagedAgent, "agentId" | "deployment" | "nodeName">,
  clusterName: string,
): string {
  return `Revoke credential for agent ${agentDisplayName(agent)} on cluster ${clusterName}`;
}

/** Explicit inline confirmation copy: names the agent and cluster and states plainly what breaks. */
export function agentRevocationConfirmation(target: AgentRevocationTarget): string {
  return `Revoke the credential for agent ${target.agentId} on cluster ${target.clusterName}? ` +
    "That agent immediately stops reporting heartbeats, scans and runtime evidence, and it cannot " +
    "reconnect until it is re-enrolled with a new one-time enrollment token. This cannot be undone " +
    "for this credential.";
}

/** Builds the exact request the route accepts, rejecting anything it would reject anyway. */
export function buildAgentRevocationRequest(target: AgentRevocationTarget): AgentRevocationRequest {
  if (!AGENT_REVOCATION_AGENT_ID.test(target.agentId)) {
    throw new AgentRevocationInputError("The agent identifier is not a Sutra Kubernetes agent id");
  }
  if (!AGENT_REVOCATION_CONNECTION_ID.test(target.connectionId)) {
    throw new AgentRevocationInputError("The cloud connection identifier is invalid");
  }
  if (!AGENT_REVOCATION_CLUSTER_ID.test(target.clusterId)) {
    throw new AgentRevocationInputError("The cluster identifier is invalid");
  }
  return {
    path: `/api/v1/kubernetes/agents/${encodeURIComponent(target.agentId)}/revoke`,
    // Exactly the two keys the route allows — an extra key is rejected as INVALID_INPUT.
    body: { connectionId: target.connectionId, clusterId: target.clusterId },
  };
}

/**
 * Reflects a confirmed revocation in a listed agent set. Only the named agent
 * changes and only to "revoked"; heartbeat history is preserved because it is
 * evidence of what the agent last reported, not a claim that it is still live.
 */
export function applyAgentRevocation(
  agents: readonly ManagedAgent[],
  agentId: string,
): readonly ManagedAgent[] {
  return agents.map((agent) => (agent.agentId === agentId && agent.state !== "revoked"
    ? { ...agent, state: "revoked" as const }
    : agent));
}

/** True when the agent still holds a usable credential, so revocation is meaningful. */
export function isRevocable(agent: Pick<ManagedAgent, "state">): boolean {
  return agent.state !== "revoked";
}
