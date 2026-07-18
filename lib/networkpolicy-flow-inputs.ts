// Adapter from normalized Cilium/Hubble flows to the NetworkPolicy generator's
// inputs. Each observed FORWARDED L4 flow A -> B:port is emitted twice — once
// ingress-tagged (so B's ingress rule admits A) and once egress-tagged (so A's
// egress rule allows reaching B) — because a single wire observation is both. Only
// pod-to-pod TCP/UDP flows with a named workload on both ends and a real port are
// used; world/service-only endpoints and ICMP/other flows can't be a podSelector
// target, so they are dropped, never guessed. Workloads are derived from the
// endpoints actually seen; their labels are left empty (the generator then emits a
// namespace-scoped podSelector and marks the policy INCOMPLETE) rather than
// synthesizing a label the evidence never carried.
import type { NormalizedHubbleFlow } from "./hubble-flow-evidence.ts";
import type {
  NetworkPolicyFlow,
  NetworkPolicyProtocol,
  NetworkPolicyWorkload,
} from "./kubernetes-networkpolicy-generator.ts";

export interface NetworkPolicyInputs {
  readonly workloads: readonly NetworkPolicyWorkload[];
  readonly flows: readonly NetworkPolicyFlow[];
}

interface NamedEndpoint {
  readonly namespace: string;
  readonly name: string;
}

function namedEndpoint(identity: NormalizedHubbleFlow["source"]): NamedEndpoint | null {
  if (identity.world) return null;
  const namespace = identity.namespace?.trim();
  const name = identity.workloadName?.trim();
  if (namespace === undefined || namespace.length === 0 || name === undefined || name.length === 0) return null;
  return { namespace, name };
}

function policyProtocol(protocol: NormalizedHubbleFlow["protocol"]): NetworkPolicyProtocol | null {
  return protocol === "TCP" || protocol === "UDP" ? protocol : null;
}

export function hubbleFlowsToPolicyInputs(flows: readonly NormalizedHubbleFlow[]): NetworkPolicyInputs {
  const workloads = new Map<string, NetworkPolicyWorkload>();
  const policyFlows: NetworkPolicyFlow[] = [];
  const addWorkload = (endpoint: NamedEndpoint): void => {
    const key = `${endpoint.namespace} ${endpoint.name}`;
    if (!workloads.has(key)) workloads.set(key, { namespace: endpoint.namespace, name: endpoint.name, labels: {} });
  };

  for (const flow of flows) {
    if (flow.verdict !== "forwarded") continue;
    const protocol = policyProtocol(flow.protocol);
    if (protocol === null) continue;
    const port = flow.destinationPort;
    if (port === null || !Number.isSafeInteger(port) || port < 1 || port > 65_535) continue;
    const source = namedEndpoint(flow.source);
    const dest = namedEndpoint(flow.destination);
    if (source === null || dest === null) continue;

    addWorkload(source);
    addWorkload(dest);
    const base = { source, dest, destPort: port, protocol, verdict: "forwarded" as const };
    policyFlows.push({ ...base, direction: "ingress" }, { ...base, direction: "egress" });
  }

  return { workloads: [...workloads.values()], flows: policyFlows };
}
