// Guided remediation: turns an Issue into concrete, copyable fix artifacts —
// a Kyverno audit policy, a kubectl securityContext patch, a default-deny
// NetworkPolicy, or an image-upgrade step. Every artifact is a suggestion the
// operator reviews and applies; Sutra generates nothing it would run itself,
// and each carries an explicit validation note. The workload kind is not always
// known from the issue, so patches name it as a placeholder to confirm.

export type RemediationArtifactKind = "kyverno-policy" | "kubectl-patch" | "network-policy" | "image-upgrade" | "rbac-review";

export interface RemediationArtifact {
  readonly kind: RemediationArtifactKind;
  readonly title: string;
  readonly language: "yaml" | "bash";
  readonly content: string;
  readonly note: string;
}

export interface RemediationInput {
  readonly ruleId: string;
  readonly workload: string; // "namespace/name"
  readonly packageName?: string | null;
  readonly fixedVersion?: string | null;
  readonly cveId?: string | null;
}

export interface RemediationPlan {
  readonly schema: "sutra.kubernetes-remediation.v1";
  readonly artifacts: readonly RemediationArtifact[];
  readonly disclaimer: string;
}

const REMEDIATION_DISCLAIMER =
  "These are operator-validated suggestions, not automatic changes. Review each " +
  "artifact against the workload's real spec, confirm the resource kind, and " +
  "apply it through your own reviewed change process. Kyverno policies are " +
  "generated in Audit mode; promote to Enforce only after review.";

function splitWorkload(workload: string): { namespace: string; name: string } {
  const slash = workload.indexOf("/");
  if (slash < 0) return { namespace: "default", name: workload || "workload" };
  return { namespace: workload.slice(0, slash) || "default", name: workload.slice(slash + 1) || "workload" };
}

function disallowPrivilegedPolicy(): RemediationArtifact {
  return {
    kind: "kyverno-policy",
    title: "Kyverno policy — disallow privileged and require non-root (Audit)",
    language: "yaml",
    content: [
      "apiVersion: kyverno.io/v1",
      "kind: ClusterPolicy",
      "metadata:",
      "  name: sutra-disallow-privileged",
      "  annotations:",
      "    policies.kyverno.io/title: Disallow privileged and enforce non-root",
      "spec:",
      "  validationFailureAction: Audit",
      "  background: true",
      "  rules:",
      "    - name: privileged-containers",
      "      match:",
      "        any:",
      "          - resources:",
      "              kinds: [Pod]",
      "      validate:",
      "        message: Privileged containers are not allowed.",
      "        pattern:",
      "          spec:",
      "            =(securityContext):",
      "              =(runAsNonRoot): true",
      "            containers:",
      "              - =(securityContext):",
      "                  =(privileged): false",
      "                  =(allowPrivilegeEscalation): false",
      "",
    ].join("\n"),
    note: "Cluster-wide guardrail. Starts in Audit so nothing is blocked; review PolicyReports, then promote to Enforce.",
  };
}

function securityContextPatch(workload: string): RemediationArtifact {
  const { namespace, name } = splitWorkload(workload);
  return {
    kind: "kubectl-patch",
    title: `kubectl patch — harden ${namespace}/${name} security context`,
    language: "bash",
    content: [
      "# Confirm the workload kind (deployment/statefulset/daemonset) before applying.",
      `kubectl -n ${namespace} patch deployment ${name} --type merge -p '{`,
      '  "spec": { "template": { "spec": {',
      '    "securityContext": { "runAsNonRoot": true },',
      '    "containers": [ { "name": "<container>", "securityContext": {',
      '      "privileged": false, "allowPrivilegeEscalation": false,',
      '      "readOnlyRootFilesystem": true, "capabilities": { "drop": ["ALL"] }',
      "    } } ]",
      "  } } }",
      "}'",
      "",
    ].join("\n"),
    note: "Replace <container> with each container name. Roll out during a maintenance window and verify the workload stays healthy.",
  };
}

function defaultDenyNetworkPolicy(workload: string): RemediationArtifact {
  const { namespace } = splitWorkload(workload);
  return {
    kind: "network-policy",
    title: `NetworkPolicy — default-deny ingress in ${namespace}`,
    language: "yaml",
    content: [
      "apiVersion: networking.k8s.io/v1",
      "kind: NetworkPolicy",
      "metadata:",
      "  name: sutra-default-deny-ingress",
      `  namespace: ${namespace}`,
      "spec:",
      "  podSelector: {}",
      "  policyTypes: [Ingress]",
      "  ingress: []",
      "",
    ].join("\n"),
    note: "Denies all ingress in the namespace, then add explicit allow rules for required sources. Validate connectivity before and after (CNI must enforce NetworkPolicy).",
  };
}

function imageUpgrade(input: RemediationInput): RemediationArtifact {
  const { namespace, name } = splitWorkload(input.workload);
  const pkg = input.packageName ?? "the affected package";
  const fix = input.fixedVersion;
  return {
    kind: "image-upgrade",
    title: `Rebuild and roll ${namespace}/${name}${input.cveId ? ` for ${input.cveId}` : ""}`,
    language: "bash",
    content: [
      `# ${input.cveId ?? "Vulnerability"} in ${namespace}/${name}`,
      fix
        ? `# Upgrade ${pkg} to ${fix} or later in the image, rebuild, then roll out the new digest.`
        : `# No fixed version is published for ${pkg}; mitigate (remove/replace the package or restrict exposure) and rescan.`,
      "# 1. Rebuild the image with the patched package and push an immutable digest.",
      `# 2. kubectl -n ${namespace} set image deployment/${name} <container>=<registry>/<image>@sha256:<new-digest>`,
      "# 3. Trigger a Trivy re-scan and confirm the CVE clears on the Vulnerability updates page.",
      "",
    ].join("\n"),
    note: "Pin the new image by digest, not a mutable tag, so the fix cannot silently regress.",
  };
}

function rbacReview(workload: string): RemediationArtifact {
  const { namespace, name } = splitWorkload(workload);
  return {
    kind: "rbac-review",
    title: `Scope RBAC for ${namespace}/${name} to least privilege`,
    language: "bash",
    content: [
      `# Review what the workload's ServiceAccount can do, then tighten its Role.`,
      `kubectl -n ${namespace} get rolebindings,clusterrolebindings -o wide | grep ${name} || true`,
      "# Replace wildcard verbs/resources and remove escalate/bind/impersonate; grant only the",
      "# get/list/watch (and specific writes) the workload actually needs. See Effective permissions.",
      "",
    ].join("\n"),
    note: "Use the Effective permissions (CIEM) view to confirm the reduced grants still cover the workload's real access.",
  };
}

export function buildRemediationPlan(input: RemediationInput): RemediationPlan {
  const artifacts: RemediationArtifact[] = [];
  switch (input.ruleId) {
    case "exposed-privileged-workload":
    case "runtime-active-privileged-workload":
      artifacts.push(securityContextPatch(input.workload), disallowPrivilegedPolicy());
      break;
    case "exposed-overpermissioned-identity":
      artifacts.push(rbacReview(input.workload));
      break;
    case "exposed-vulnerable-workload":
    case "runtime-active-vulnerable-workload":
    case "critical-vulnerability":
      artifacts.push(imageUpgrade(input));
      break;
    default:
      break;
  }
  // A reachable workload always benefits from restricting ingress.
  if (input.ruleId.startsWith("exposed-")) artifacts.push(defaultDenyNetworkPolicy(input.workload));

  return { schema: "sutra.kubernetes-remediation.v1", artifacts, disclaimer: REMEDIATION_DISCLAIMER };
}
