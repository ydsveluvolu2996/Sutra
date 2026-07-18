// Maps normalized CMDB resources into the CIEM engine's inputs. Every read is
// guarded: a resource missing rules, a binding without subjects, or an IAM role
// without a parsed policy degrades to an honest empty/unresolved value rather
// than a crash or an invented entitlement.
import type {
  CiemBinding,
  CiemIamRole,
  CiemIamStatement,
  CiemRole,
  CiemServiceAccount,
  CiemSubjectRef,
} from "./kubernetes-ciem.ts";
import type { JsonValue } from "./pilot-types.ts";

interface ResourceLike {
  readonly resourceKey: string;
  readonly service: string;
  readonly resourceType: string;
  readonly arn: string | null;
  readonly name: string | null;
  readonly configuration: Readonly<Record<string, JsonValue>>;
}

function obj(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : null;
}
function arr(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}
function str(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function strList(value: JsonValue | undefined): string[] {
  return arr(value).filter((entry): entry is string => typeof entry === "string");
}

function kindOf(resource: ResourceLike): string {
  return (str(resource.configuration.kind) ?? resource.resourceType).toLocaleLowerCase("en-US");
}
function namespaceOf(resource: ResourceLike): string | null {
  return str(resource.configuration.namespace) ?? str(obj(resource.configuration.metadata)?.namespace);
}
function nameOf(resource: ResourceLike): string {
  return resource.name?.trim() || str(obj(resource.configuration.metadata)?.name) || resource.resourceKey;
}
function roleId(kind: "role" | "clusterrole", namespace: string | null, name: string): string {
  return kind === "clusterrole" ? `clusterrole:${name}` : `role:${namespace ?? "-"}/${name}`;
}

function annotationRoleArn(resource: ResourceLike): string | null {
  const annotations = obj(obj(resource.configuration.metadata)?.annotations) ?? obj(resource.configuration.annotations);
  if (annotations !== null) {
    for (const [key, value] of Object.entries(annotations)) {
      if (/eks\.amazonaws\.com\/role-arn$|rolearn$|iamrolearn$/iu.test(key) && typeof value === "string") return value;
    }
  }
  const direct = str(resource.configuration.iamRoleArn) ?? str(resource.configuration.roleArn);
  return direct;
}

function iamStatements(resource: ResourceLike): readonly CiemIamStatement[] {
  // Accept a few common shapes: a policy document, an array of documents, or a
  // pre-normalized statements list. Anything unrecognized yields no statements.
  const documents: JsonValue[] = [];
  const single = obj(resource.configuration.policyDocument);
  if (single !== null) documents.push(single);
  for (const entry of arr(resource.configuration.policyDocuments)) documents.push(entry);
  for (const entry of arr(resource.configuration.inlinePolicies)) documents.push(entry);
  const statements: CiemIamStatement[] = [];
  const pushStatement = (raw: JsonValue) => {
    const statement = obj(raw);
    if (statement === null) return;
    const effect = str(statement.Effect) ?? str(statement.effect);
    const actions = strList(statement.Action).length > 0 ? strList(statement.Action)
      : typeof statement.Action === "string" ? [statement.Action] : strList(statement.action);
    const resources = strList(statement.Resource).length > 0 ? strList(statement.Resource)
      : typeof statement.Resource === "string" ? [statement.Resource] : strList(statement.resource);
    if (effect === null || actions.length === 0) return;
    statements.push({ effect: effect === "Deny" ? "Deny" : "Allow", actions, resources });
  };
  for (const document of documents) {
    const record = obj(document);
    if (record === null) continue;
    for (const entry of arr(record.Statement ?? record.statement)) pushStatement(entry);
  }
  for (const entry of arr(resource.configuration.statements)) pushStatement(entry);
  return statements;
}

function isIamRole(resource: ResourceLike): boolean {
  const value = `${resource.service} ${resource.resourceType}`.toLocaleLowerCase("en-US");
  return value.includes("iam") && value.includes("role");
}

export function deriveCiemInputs(resources: readonly ResourceLike[]): {
  readonly roles: readonly CiemRole[];
  readonly bindings: readonly CiemBinding[];
  readonly serviceAccounts: readonly CiemServiceAccount[];
  readonly iamRoles: readonly CiemIamRole[];
} {
  const roles: CiemRole[] = [];
  const bindings: CiemBinding[] = [];
  const serviceAccounts: CiemServiceAccount[] = [];
  const iamRoles: CiemIamRole[] = [];

  for (const resource of resources) {
    const kind = kindOf(resource);
    // The stored posture projection emits "rbacrole"/"rbacbinding" (evidence
    // kinds); raw CMDB resources use "role"/"clusterrole"/"rolebinding". Accept
    // both, deriving cluster-scope from the clusterScoped flag when present.
    const configClusterScoped = resource.configuration.clusterScoped === true;
    if (kind === "role" || kind === "clusterrole" || kind === "rbacrole") {
      const clusterScoped = kind === "clusterrole" || (kind === "rbacrole" && configClusterScoped);
      const namespace = namespaceOf(resource);
      const name = nameOf(resource);
      roles.push({
        id: roleId(clusterScoped ? "clusterrole" : "role", namespace, name),
        name,
        namespace: clusterScoped ? null : namespace,
        clusterScoped,
        rules: arr(resource.configuration.rules).flatMap((rawRule) => {
          const rule = obj(rawRule);
          return rule === null ? [] : [{
            verbs: strList(rule.verbs),
            apiGroups: strList(rule.apiGroups),
            resources: strList(rule.resources),
          }];
        }),
      });
    } else if (kind === "rolebinding" || kind === "clusterrolebinding" || kind === "rbacbinding") {
      const bindingNamespace = namespaceOf(resource);
      const refName = str(resource.configuration.roleRefName);
      const refKind = (str(resource.configuration.roleRefKind) ?? "").toLocaleLowerCase("en-US");
      if (refName === null) continue;
      const targetRoleId = refKind === "clusterrole"
        ? `clusterrole:${refName}`
        : `role:${bindingNamespace ?? "-"}/${refName}`;
      for (const rawSubject of arr(resource.configuration.subjects)) {
        const subject = obj(rawSubject);
        if (subject === null) continue;
        const subjectName = str(subject.name);
        const subjectKind = str(subject.kind);
        if (subjectName === null || subjectKind === null) continue;
        const kindValue: CiemSubjectRef["kind"] =
          subjectKind === "User" ? "User" : subjectKind === "Group" ? "Group" : "ServiceAccount";
        bindings.push({
          roleId: targetRoleId,
          subject: { kind: kindValue, namespace: str(subject.namespace), name: subjectName },
        });
      }
    } else if (kind === "serviceaccount") {
      serviceAccounts.push({ namespace: namespaceOf(resource), name: nameOf(resource), iamRoleArn: annotationRoleArn(resource) });
    } else if (isIamRole(resource)) {
      iamRoles.push({ arn: resource.arn ?? nameOf(resource), statements: iamStatements(resource) });
    }
  }

  return { roles, bindings, serviceAccounts, iamRoles };
}
