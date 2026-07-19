// Kubernetes CIEM (Cloud Infrastructure Entitlement Management): resolves the
// *effective* permissions of each RBAC subject by unioning the rules of every
// role bound to it, flags the dangerous ones, and follows IRSA
// (ServiceAccount -> IAM role) into AWS so a reviewer can answer "what can this
// pod's identity actually do — in the cluster and in the account?". Pure and
// deterministic; every entitlement is traced to a bound role, nothing inferred.

export interface CiemRule {
  readonly verbs: readonly string[];
  readonly apiGroups: readonly string[];
  readonly resources: readonly string[];
}

export interface CiemRole {
  readonly id: string;
  readonly name: string;
  readonly namespace: string | null;
  readonly clusterScoped: boolean;
  readonly rules: readonly CiemRule[];
}

export interface CiemSubjectRef {
  readonly kind: "ServiceAccount" | "User" | "Group";
  readonly namespace: string | null;
  readonly name: string;
}

export interface CiemBinding {
  readonly roleId: string;
  readonly subject: CiemSubjectRef;
}

export interface CiemServiceAccount {
  readonly namespace: string | null;
  readonly name: string;
  readonly iamRoleArn: string | null;
  // How the SA is linked to its AWS role: the IRSA OIDC annotation, an EKS Pod
  // Identity association, or null when there is no link. Both cross-plane
  // mechanisms resolve to the same reach; the source is recorded for the reviewer.
  readonly iamRoleSource?: "irsa" | "pod-identity" | null;
}

// A workload's ServiceAccount usage — the evidence that a SA is actually
// assumed by a running pod (vs bound but unused).
export interface CiemWorkloadServiceAccount {
  readonly namespace: string | null;
  readonly serviceAccountName: string | null;
}

export interface CiemIamStatement {
  readonly effect: "Allow" | "Deny";
  readonly actions: readonly string[];
  readonly resources: readonly string[];
}

export interface CiemIamRole {
  readonly arn: string;
  readonly statements: readonly CiemIamStatement[];
}

export type CiemFlag =
  | "cluster-admin" | "secrets-access" | "pod-exec" | "impersonate"
  | "escalate-or-bind" | "wildcard-verb" | "wildcard-resource"
  | "aws-reachable" | "aws-write"
  | "unused-serviceaccount" | "default-serviceaccount-in-use";

export interface CiemAwsReach {
  readonly roleArn: string;
  readonly linkage: "irsa" | "pod-identity" | null;
  readonly allowedActions: readonly string[];
  readonly allowedResources: readonly string[];
  readonly hasWriteAccess: boolean;
}

export interface CiemSubjectEntitlement {
  readonly subject: string;
  readonly subjectKind: CiemSubjectRef["kind"];
  readonly boundRoles: readonly string[];
  readonly permissions: readonly { readonly verb: string; readonly apiGroup: string; readonly resource: string }[];
  readonly flags: readonly CiemFlag[];
  readonly awsReach: CiemAwsReach | null;
  // Number of collected workloads that assume this ServiceAccount; null when no
  // workload evidence was provided (usage is unknown, never assumed zero).
  readonly usedByWorkloads: number | null;
  readonly riskScore: number;
}

export interface CiemReport {
  readonly schema: "sutra.kubernetes-ciem.v1";
  readonly subjects: readonly CiemSubjectEntitlement[];
  readonly totals: {
    readonly subjects: number;
    readonly clusterAdmins: number;
    readonly secretsReaders: number;
    readonly awsReachable: number;
    readonly awsWrite: number;
    readonly unusedServiceAccounts: number;
    readonly defaultInUse: number;
  };
  readonly disclaimer: string;
}

const ESCALATION_VERBS = new Set(["escalate", "bind"]);
const READ_VERBS = new Set(["get", "list", "watch"]);
const AWS_WRITE_PATTERN =
  /(?:^|:)(?:\*|Create|Delete|Put|Update|Modify|Terminate|Attach|Detach|Remove|Write|Add|Replace|Assume)/u;

const FLAG_WEIGHT: Readonly<Record<CiemFlag, number>> = {
  "cluster-admin": 100,
  "impersonate": 55,
  "escalate-or-bind": 50,
  "secrets-access": 40,
  "pod-exec": 35,
  "wildcard-verb": 30,
  "wildcard-resource": 25,
  "aws-write": 45,
  "aws-reachable": 20,
  "default-serviceaccount-in-use": 30,
  "unused-serviceaccount": 15,
};

const CIEM_DISCLAIMER =
  "Effective permissions are the union of the rules of every role bound to the " +
  "subject in the collected evidence. Missing binding or IAM policy evidence is " +
  "shown as unresolved, never assumed empty; AWS reach follows the IRSA " +
  "annotation or an EKS Pod Identity association and the role's collected policy " +
  "statements only. A ServiceAccount is flagged unused only when workload " +
  "evidence is present and no workload assumes it — absent workload evidence " +
  "leaves usage unknown, never assumed zero.";

function subjectKey(subject: CiemSubjectRef): string {
  return `${subject.kind}:${subject.namespace ?? "-"}/${subject.name}`;
}

function lower(values: readonly string[]): string[] {
  return values.map((value) => value.toLocaleLowerCase("en-US"));
}

function ruleMatches(rule: CiemRule, verb: string, resource: string, apiGroup: string): boolean {
  const verbs = lower(rule.verbs);
  const resources = lower(rule.resources);
  const groups = rule.apiGroups.map((group) => group.toLocaleLowerCase("en-US"));
  const has = (set: string[], value: string) => set.includes("*") || set.includes(value);
  return has(verbs, verb.toLocaleLowerCase("en-US")) &&
    has(resources, resource.toLocaleLowerCase("en-US")) &&
    (groups.includes("*") || groups.includes(apiGroup.toLocaleLowerCase("en-US")) ||
      (apiGroup === "" && groups.includes("")));
}

/** True when the subject's effective rules permit the (verb, resource) pair. */
export function subjectCan(
  entitlement: { readonly rules: readonly CiemRule[] },
  input: { readonly verb: string; readonly resource: string; readonly apiGroup?: string },
): boolean {
  return entitlement.rules.some((rule) => ruleMatches(rule, input.verb, input.resource, input.apiGroup ?? ""));
}

function awsReachOf(
  serviceAccount: CiemServiceAccount | undefined,
  iamRoles: Map<string, CiemIamRole>,
): CiemAwsReach | null {
  if (serviceAccount?.iamRoleArn == null) return null;
  const linkage = serviceAccount.iamRoleSource ?? null;
  const role = iamRoles.get(serviceAccount.iamRoleArn);
  if (role === undefined) {
    return { roleArn: serviceAccount.iamRoleArn, linkage, allowedActions: [], allowedResources: [], hasWriteAccess: false };
  }
  const denied = new Set(
    role.statements.filter((s) => s.effect === "Deny").flatMap((s) => lower(s.actions)),
  );
  const actions = [...new Set(
    role.statements.filter((s) => s.effect === "Allow").flatMap((s) => s.actions),
  )].filter((action) => !denied.has(action.toLocaleLowerCase("en-US")))
    .sort((left, right) => left.localeCompare(right, "en-US"));
  const resources = [...new Set(
    role.statements.filter((s) => s.effect === "Allow").flatMap((s) => s.resources),
  )].sort((left, right) => left.localeCompare(right, "en-US"));
  return {
    roleArn: serviceAccount.iamRoleArn,
    linkage,
    allowedActions: actions,
    allowedResources: resources,
    hasWriteAccess: actions.some((action) => AWS_WRITE_PATTERN.test(action)),
  };
}

function deriveFlags(rules: readonly CiemRule[], awsReach: CiemAwsReach | null): CiemFlag[] {
  const flags = new Set<CiemFlag>();
  for (const rule of rules) {
    const verbs = lower(rule.verbs);
    const resources = lower(rule.resources);
    if (verbs.includes("*") && rule.apiGroups.includes("*") && resources.includes("*")) flags.add("cluster-admin");
    if (verbs.includes("*")) flags.add("wildcard-verb");
    if (resources.includes("*")) flags.add("wildcard-resource");
    if (verbs.some((verb) => ESCALATION_VERBS.has(verb))) flags.add("escalate-or-bind");
    if (verbs.includes("impersonate")) flags.add("impersonate");
    if (resources.includes("secrets") && (verbs.includes("*") || verbs.some((verb) => READ_VERBS.has(verb)))) {
      flags.add("secrets-access");
    }
    if (resources.includes("pods/exec") || resources.includes("pods/attach")) flags.add("pod-exec");
  }
  if (awsReach !== null) {
    flags.add("aws-reachable");
    if (awsReach.hasWriteAccess) flags.add("aws-write");
  }
  return [...flags];
}

export function buildKubernetesCiem(input: {
  readonly roles: readonly CiemRole[];
  readonly bindings: readonly CiemBinding[];
  readonly serviceAccounts: readonly CiemServiceAccount[];
  readonly iamRoles: readonly CiemIamRole[];
  readonly workloadServiceAccounts?: readonly CiemWorkloadServiceAccount[];
}): CiemReport {
  const rolesById = new Map(input.roles.map((role) => [role.id, role]));
  const iamRoles = new Map(input.iamRoles.map((role) => [role.arn, role]));
  const serviceAccounts = new Map(
    input.serviceAccounts.map((sa) => [`${sa.namespace ?? "-"}/${sa.name}`, sa]),
  );

  // ServiceAccount usage by workloads. Only computed when workload evidence was
  // provided — otherwise usage is unknown (null), never assumed zero. A missing
  // serviceAccountName means the pod's default SA for its namespace.
  const usageProvided = input.workloadServiceAccounts !== undefined;
  const usageBySa = new Map<string, number>();
  for (const workload of input.workloadServiceAccounts ?? []) {
    const name = workload.serviceAccountName ?? "default";
    const key = `${workload.namespace ?? "-"}/${name}`;
    usageBySa.set(key, (usageBySa.get(key) ?? 0) + 1);
  }

  const bySubject = new Map<string, { subject: CiemSubjectRef; roleIds: Set<string> }>();
  for (const binding of input.bindings) {
    if (!rolesById.has(binding.roleId)) continue;
    const key = subjectKey(binding.subject);
    const existing = bySubject.get(key);
    if (existing === undefined) bySubject.set(key, { subject: binding.subject, roleIds: new Set([binding.roleId]) });
    else existing.roleIds.add(binding.roleId);
  }

  const subjects: CiemSubjectEntitlement[] = [];
  for (const { subject, roleIds } of bySubject.values()) {
    const boundRoles = [...roleIds].map((id) => rolesById.get(id)).filter((role): role is CiemRole => role !== undefined);
    const rules = boundRoles.flatMap((role) => role.rules);
    const permissions = [...new Map(
      rules.flatMap((rule) =>
        rule.verbs.flatMap((verb) =>
          rule.apiGroups.flatMap((apiGroup) =>
            rule.resources.map((resource) => {
              const perm = { verb, apiGroup, resource };
              return [`${verb}|${apiGroup}|${resource}`, perm] as const;
            }),
          ),
        ),
      ),
    ).values()].sort((left, right) =>
      left.resource.localeCompare(right.resource, "en-US") || left.verb.localeCompare(right.verb, "en-US"));

    const awsReach = subject.kind === "ServiceAccount"
      ? awsReachOf(serviceAccounts.get(`${subject.namespace ?? "-"}/${subject.name}`), iamRoles)
      : null;
    const flags = deriveFlags(rules, awsReach);

    // Right-sizing / over-privilege signals, only where the subject is a
    // ServiceAccount and workload-usage evidence exists.
    const usedByWorkloads = usageProvided && subject.kind === "ServiceAccount"
      ? usageBySa.get(`${subject.namespace ?? "-"}/${subject.name}`) ?? 0
      : null;
    if (usedByWorkloads === 0 && rules.length > 0) flags.push("unused-serviceaccount");
    if (subject.kind === "ServiceAccount" && subject.name === "default" &&
      usedByWorkloads !== null && usedByWorkloads > 0 && permissions.length > 0) {
      flags.push("default-serviceaccount-in-use");
    }

    const riskScore = flags.reduce((sum, flag) => sum + FLAG_WEIGHT[flag], 0);

    subjects.push({
      subject: subjectKey(subject),
      subjectKind: subject.kind,
      boundRoles: boundRoles.map((role) => role.name).sort((a, b) => a.localeCompare(b, "en-US")),
      permissions,
      flags: flags.sort((a, b) => FLAG_WEIGHT[b] - FLAG_WEIGHT[a] || a.localeCompare(b, "en-US")),
      awsReach,
      usedByWorkloads,
      riskScore,
    });
  }

  subjects.sort((left, right) =>
    right.riskScore - left.riskScore || left.subject.localeCompare(right.subject, "en-US"));

  return {
    schema: "sutra.kubernetes-ciem.v1",
    subjects,
    totals: {
      subjects: subjects.length,
      clusterAdmins: subjects.filter((s) => s.flags.includes("cluster-admin")).length,
      secretsReaders: subjects.filter((s) => s.flags.includes("secrets-access")).length,
      awsReachable: subjects.filter((s) => s.flags.includes("aws-reachable")).length,
      awsWrite: subjects.filter((s) => s.flags.includes("aws-write")).length,
      unusedServiceAccounts: subjects.filter((s) => s.flags.includes("unused-serviceaccount")).length,
      defaultInUse: subjects.filter((s) => s.flags.includes("default-serviceaccount-in-use")).length,
    },
    disclaimer: CIEM_DISCLAIMER,
  };
}
