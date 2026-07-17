export const KUBERNETES_INSTALLATION_MODULES = [
  "inventory",
  "trivy",
  "kyverno",
  "falco",
  "cilium",
  "supply-chain",
] as const;

export type KubernetesInstallationModule =
  typeof KUBERNETES_INSTALLATION_MODULES[number];

export interface KubernetesInstallationModulePlan {
  readonly id: KubernetesInstallationModule;
  readonly name: string;
  readonly purpose: string;
  readonly version: string;
  readonly risk: "low" | "medium" | "high";
  readonly privileges: readonly string[];
  readonly exclusions: readonly string[];
  readonly expectedHealthChecks: readonly string[];
  readonly installCommands: readonly string[];
  readonly upgradeCommand: string;
  readonly rollbackCommand: string;
}

export interface KubernetesInstallationPlan {
  readonly schema: "sutra.kubernetes-installation-plan.v1";
  readonly clusterId: string;
  readonly clusterName: string;
  readonly context: string;
  readonly modules: readonly KubernetesInstallationModulePlan[];
  readonly prerequisites: readonly {
    readonly id: string;
    readonly label: string;
    readonly required: true;
    readonly review: string;
  }[];
  readonly lifecycle: {
    readonly state: "planned";
    readonly preflightCommand: string;
    readonly healthCommand: string;
    readonly installOrder: readonly KubernetesInstallationModule[];
    readonly rollbackOrder: readonly KubernetesInstallationModule[];
    readonly requiresCniApproval: boolean;
    readonly mutationsExecuted: false;
  };
  readonly safety: {
    readonly secretsCollected: false;
    readonly configMapValuesCollected: false;
    readonly kubeconfigAcceptedByApi: false;
    readonly auditFirstAdmission: true;
    readonly ciliumRequiresExplicitApproval: true;
  };
}

const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u;

export class KubernetesInstallationPlanError extends Error {
  public readonly code = "INVALID_INPUT";

  public constructor() {
    super("Kubernetes installation plan request rejected");
    this.name = "KubernetesInstallationPlanError";
  }
}

function reject(): never {
  throw new KubernetesInstallationPlanError();
}

function commandModules(
  modules: readonly KubernetesInstallationModule[],
): readonly string[] {
  return modules.filter((module): module is "trivy" | "kyverno" | "falco" | "cilium" =>
    module === "trivy" || module === "kyverno" || module === "falco" || module === "cilium");
}

function stackCommand(
  operation: "plan" | "preflight" | "apply" | "health" | "uninstall",
  context: string,
  modules: readonly KubernetesInstallationModule[],
): string {
  const stackModules = commandModules(modules);
  if (stackModules.length === 0) return "Not required for the selected modules";
  const ciliumApproval = stackModules.includes("cilium") ? " --allow-cni-change" : "";
  const execution = operation === "apply" || operation === "uninstall" ? " --execute" : "";
  const format = operation === "health" || operation === "uninstall" ? " --format json" : "";
  return `node scripts/kubernetes-security-stack.mjs ${operation} --context ${context} ` +
    `--modules ${stackModules.join(",")}${ciliumApproval}${execution}${format}`;
}

function modulePlan(
  module: KubernetesInstallationModule,
  context: string,
  selected: readonly KubernetesInstallationModule[],
): KubernetesInstallationModulePlan {
  const lifecycle = (operation: "apply" | "uninstall") =>
    stackCommand(operation, context, [module]);
  switch (module) {
    case "inventory":
      return {
        id: module,
        name: "Inventory and KSPM",
        purpose: "Read-only inventory, posture evidence, RBAC and exposure context.",
        version: "sutra-agent.v1",
        risk: "low",
        privileges: ["get/list/watch approved metadata resources"],
        exclusions: ["Secret payloads", "ConfigMap values", "exec", "logs"],
        expectedHealthChecks: ["agent heartbeat", "collector coverage", "latest complete scan"],
        installCommands: [
          "Issue a one-time enrollment token from the registered cluster workspace",
          "Install the reviewed Sutra agent chart with the exact cluster binding",
        ],
        upgradeCommand: "helm upgrade sutra-agent ./deploy/charts/sutra-agent --namespace sutra-system --atomic --wait",
        rollbackCommand: "helm rollback sutra-agent --namespace sutra-system --wait",
      };
    case "trivy":
      return {
        id: module,
        name: "Trivy evidence",
        purpose: "Image vulnerabilities, configuration, RBAC, compliance and SBOM reports.",
        version: "chart 0.32.1",
        risk: "low",
        privileges: ["Trivy Operator report CRDs", "workload image references"],
        exclusions: ["image layers in Sutra", "raw secret values"],
        expectedHealthChecks: ["helm release", "operator readiness", "report coverage"],
        installCommands: [lifecycle("apply")],
        upgradeCommand: lifecycle("apply"),
        rollbackCommand: lifecycle("uninstall"),
      };
    case "kyverno":
      return {
        id: module,
        name: "Kyverno admission",
        purpose: "Audit-first admission policies, PolicyReports and governed promotion.",
        version: "chart 3.8.2",
        risk: "medium",
        privileges: ["admission webhook", "PolicyReport CRDs"],
        exclusions: ["blocking mode by default", "mutation policies"],
        expectedHealthChecks: ["helm release", "webhook readiness", "audit policy reports"],
        installCommands: [lifecycle("apply")],
        upgradeCommand: lifecycle("apply"),
        rollbackCommand: lifecycle("uninstall"),
      };
    case "falco":
      return {
        id: module,
        name: "Falco runtime detection",
        purpose: "Kernel/eBPF runtime detections delivered through a signed gateway.",
        version: "chart 9.1.0",
        risk: "medium",
        privileges: ["privileged node sensor", "read-only kernel event stream"],
        exclusions: ["shell access", "raw command-line persistence", "automatic containment"],
        expectedHealthChecks: ["helm release", "node sensor coverage", "signed gateway heartbeat"],
        installCommands: [lifecycle("apply")],
        upgradeCommand: lifecycle("apply"),
        rollbackCommand: lifecycle("uninstall"),
      };
    case "cilium":
      return {
        id: module,
        name: "Cilium and Hubble",
        purpose: "AWS VPC CNI-chained flow metadata and service-map visibility.",
        version: "chart 1.19.5",
        risk: "high",
        privileges: ["privileged node networking", "flow metadata"],
        exclusions: ["packet payloads", "DNS contents", "exclusive CNI ownership"],
        expectedHealthChecks: ["Cilium DaemonSet", "operator", "Hubble relay", "AWS VPC CNI rollback"],
        installCommands: [lifecycle("apply")],
        upgradeCommand: lifecycle("apply"),
        rollbackCommand: lifecycle("uninstall"),
      };
    case "supply-chain":
      return {
        id: module,
        name: "Supply-chain verification",
        purpose: "Trivy/Syft evidence, keyless Cosign identity and provenance admission context.",
        version: "workflow v1",
        risk: "medium",
        privileges: ["GitHub OIDC to exact ECR repository", "read-only signature verification"],
        exclusions: ["long-lived registry keys", "unreviewed admission blocking"],
        expectedHealthChecks: ["immutable digest", "SBOM attestation", "signature identity", "provenance"],
        installCommands: [
          "Configure the reviewed GitHub OIDC role and immutable ECR repository",
          selected.includes("kyverno")
            ? "Review optional Cosign identity policies before audit-only activation"
            : "Select Kyverno before enabling admission verification",
        ],
        upgradeCommand: "Review and pin the next workflow, scanner and signer versions in a pull request",
        rollbackCommand: "Disable the governed workflow environment and retain immutable release evidence",
      };
  }
}

export function createKubernetesInstallationPlan(input: {
  readonly clusterId: string;
  readonly clusterName: string;
  readonly context: string;
  readonly modules: readonly KubernetesInstallationModule[];
}): KubernetesInstallationPlan {
  if (
    !IDENTIFIER.test(input.clusterId) ||
    !IDENTIFIER.test(input.clusterName) ||
    !CONTEXT.test(input.context) ||
    input.modules.length < 1 ||
    input.modules.length > KUBERNETES_INSTALLATION_MODULES.length ||
    new Set(input.modules).size !== input.modules.length ||
    input.modules.some((module) => !KUBERNETES_INSTALLATION_MODULES.includes(module))
  ) reject();
  const installOrder = KUBERNETES_INSTALLATION_MODULES.filter((module) =>
    input.modules.includes(module));
  const requiresCniApproval = installOrder.includes("cilium");
  return {
    schema: "sutra.kubernetes-installation-plan.v1",
    clusterId: input.clusterId,
    clusterName: input.clusterName,
    context: input.context,
    modules: installOrder.map((module) => modulePlan(module, input.context, installOrder)),
    prerequisites: [
      {
        id: "customer-approval",
        label: "Customer change approval",
        required: true,
        review: "A customer administrator reviews every generated command before execution.",
      },
      {
        id: "tooling",
        label: "Pinned cluster tooling",
        required: true,
        review: "kubectl and Helm must address the selected context; chart versions remain pinned.",
      },
      {
        id: "access",
        label: "Least-privilege access",
        required: true,
        review: "The installer identity needs only the reviewed RBAC and namespace permissions.",
      },
      ...(requiresCniApproval ? [{
        id: "cni-change",
        label: "CNI change and rollback approval",
        required: true as const,
        review: "Cilium uses AWS VPC CNI chaining and requires an explicit maintenance and rollback window.",
      }] : []),
    ],
    lifecycle: {
      state: "planned",
      preflightCommand: stackCommand("preflight", input.context, installOrder),
      healthCommand: stackCommand("health", input.context, installOrder),
      installOrder,
      rollbackOrder: [...installOrder].reverse(),
      requiresCniApproval,
      mutationsExecuted: false,
    },
    safety: {
      secretsCollected: false,
      configMapValuesCollected: false,
      kubeconfigAcceptedByApi: false,
      auditFirstAdmission: true,
      ciliumRequiresExplicitApproval: true,
    },
  };
}
