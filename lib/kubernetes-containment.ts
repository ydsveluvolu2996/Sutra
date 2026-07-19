// Automated containment PLANNING for a runtime (Falco) event. Given a normalized
// runtime event, this deterministically proposes concrete containment actions —
// isolate the pod (quarantine label + deny-all NetworkPolicy), cordon the node,
// or terminate the pod — scaled by severity. It is a PLAN GENERATOR ONLY: every
// action is copyable YAML/kubectl the operator reviews and applies through their
// own change process. Sutra never applies containment automatically; the plan
// carries automaticApply:false and requiresHumanApproval:true, and every action
// is individually approval-gated. Actions are emitted only when the event
// carries the identity they need — no action is synthesized against unknown
// targets.
import type { FalcoPriority, NormalizedFalcoRuntimeEvent } from "./falco-runtime-types.ts";

export type ContainmentSeverity = "low" | "medium" | "high" | "critical";
export type ContainmentActionKind = "isolate-pod" | "cordon-node" | "terminate-pod";

export interface ContainmentAction {
  readonly kind: ContainmentActionKind;
  readonly title: string;
  readonly language: "yaml" | "bash";
  readonly content: string;
  readonly appliesTo: string;
  readonly note: string;
  readonly requiresApproval: true;
}

export interface ContainmentPlan {
  readonly schema: "sutra.kubernetes-containment-plan.v1";
  readonly severity: ContainmentSeverity;
  readonly actions: readonly ContainmentAction[];
  readonly requiresHumanApproval: true;
  readonly automaticApply: false;
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

const CONTAINMENT_DISCLAIMER =
  "This is a containment PLAN for human review, not an automatic action. Sutra " +
  "never isolates, cordons, or terminates a workload on its own. Review each " +
  "action against the live cluster, confirm the target, and apply it through " +
  "your own approved change process. Containment can disrupt healthy traffic.";

const CONTAINMENT_LIMITATIONS: readonly string[] = [
  "PLAN_ONLY_NO_AUTOMATIC_APPLY",
  "ACTIONS_REQUIRE_HUMAN_APPROVAL",
  "NETWORKPOLICY_ISOLATION_REQUIRES_A_CNI_THAT_ENFORCES_IT",
];

function severityOf(priority: FalcoPriority): ContainmentSeverity {
  if (priority === "emergency" || priority === "alert" || priority === "critical") return "critical";
  if (priority === "error") return "high";
  if (priority === "warning") return "medium";
  return "low";
}

function isolatePod(namespace: string, podName: string): ContainmentAction {
  return {
    kind: "isolate-pod",
    title: `Isolate pod ${namespace}/${podName} (quarantine label + deny-all NetworkPolicy)`,
    language: "yaml",
    appliesTo: `${namespace}/${podName}`,
    content: [
      "# 1. Label the pod so the policy below selects only it:",
      `#    kubectl -n ${namespace} label pod ${podName} sutra.io/quarantine=true --overwrite`,
      "# 2. Apply the deny-all policy (isolates every quarantined pod in the namespace):",
      "apiVersion: networking.k8s.io/v1",
      "kind: NetworkPolicy",
      "metadata:",
      "  name: sutra-quarantine",
      `  namespace: ${namespace}`,
      "spec:",
      "  podSelector:",
      "    matchLabels:",
      "      sutra.io/quarantine: \"true\"",
      "  policyTypes: [Ingress, Egress]",
      "  ingress: []",
      "  egress: []",
      "",
    ].join("\n"),
    note: "Cuts all ingress and egress for the labelled pod. Requires a CNI that enforces NetworkPolicy (e.g. Cilium). Preserves the pod for forensics rather than deleting it.",
    requiresApproval: true,
  };
}

function cordonNode(nodeName: string): ContainmentAction {
  return {
    kind: "cordon-node",
    title: `Cordon node ${nodeName} to stop new scheduling`,
    language: "bash",
    appliesTo: nodeName,
    content: [
      `# Mark the node unschedulable (running pods keep running):`,
      `kubectl cordon ${nodeName}`,
      `# Optionally drain after confirming impact (evicts pods; respects PodDisruptionBudgets):`,
      `# kubectl drain ${nodeName} --ignore-daemonsets --delete-emptydir-data`,
      "",
    ].join("\n"),
    note: "Cordon is reversible with `kubectl uncordon`. Only drain after confirming the blast radius; draining evicts workloads.",
    requiresApproval: true,
  };
}

function terminatePod(namespace: string, podName: string): ContainmentAction {
  return {
    kind: "terminate-pod",
    title: `Terminate pod ${namespace}/${podName}`,
    language: "bash",
    appliesTo: `${namespace}/${podName}`,
    content: [
      "# Deletes the compromised pod instance. A controller (Deployment/DaemonSet)",
      "# will usually recreate it — scale the owning workload to 0 first if the",
      "# whole workload must stop.",
      `kubectl -n ${namespace} delete pod ${podName}`,
      "",
    ].join("\n"),
    note: "Destroys running-process forensics for this pod. Prefer isolate-pod when evidence must be preserved; a controller may immediately recreate the pod.",
    requiresApproval: true,
  };
}

export function buildContainmentPlan(input: { readonly event: NormalizedFalcoRuntimeEvent }): ContainmentPlan {
  const severity = severityOf(input.event.priority);
  const { namespace, podName, nodeName } = input.event;
  const hasPod = namespace !== null && podName !== null;
  const actions: ContainmentAction[] = [];

  // medium and above propose pod isolation (preserves forensics); critical/high
  // add node cordon (when the node is known) and, for critical only, termination.
  if ((severity === "critical" || severity === "high" || severity === "medium") && hasPod) {
    actions.push(isolatePod(namespace, podName));
  }
  if ((severity === "critical" || severity === "high") && nodeName !== null) {
    actions.push(cordonNode(nodeName));
  }
  if (severity === "critical" && hasPod) {
    actions.push(terminatePod(namespace, podName));
  }

  return {
    schema: "sutra.kubernetes-containment-plan.v1",
    severity,
    actions,
    requiresHumanApproval: true,
    automaticApply: false,
    limitations: CONTAINMENT_LIMITATIONS,
    disclaimer: CONTAINMENT_DISCLAIMER,
  };
}
