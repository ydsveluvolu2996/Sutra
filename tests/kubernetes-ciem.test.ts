import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKubernetesCiem,
  subjectCan,
  type CiemBinding,
  type CiemIamRole,
  type CiemRole,
  type CiemServiceAccount,
} from "../lib/kubernetes-ciem.ts";

function role(id: string, rules: CiemRole["rules"], over: Partial<CiemRole> = {}): CiemRole {
  return { id, name: id, namespace: "payments", clusterScoped: false, rules, ...over };
}
function saBinding(roleId: string, name: string, namespace = "payments"): CiemBinding {
  return { roleId, subject: { kind: "ServiceAccount", namespace, name } };
}
const base = { roles: [], bindings: [], serviceAccounts: [], iamRoles: [] };

test("effective permissions union the rules of every role bound to a subject", () => {
  const report = buildKubernetesCiem({
    ...base,
    roles: [
      role("reader", [{ verbs: ["get", "list"], apiGroups: [""], resources: ["pods"] }]),
      role("writer", [{ verbs: ["create"], apiGroups: ["apps"], resources: ["deployments"] }]),
    ],
    bindings: [saBinding("reader", "app"), saBinding("writer", "app")],
  });
  assert.equal(report.subjects.length, 1);
  const app = report.subjects[0];
  assert.deepEqual(app?.boundRoles, ["reader", "writer"]);
  assert.ok(app?.permissions.some((p) => p.verb === "get" && p.resource === "pods"));
  assert.ok(app?.permissions.some((p) => p.verb === "create" && p.resource === "deployments"));
});

test("subjectCan honors verb, resource, apiGroup and wildcards", () => {
  const rules = [
    { verbs: ["get"], apiGroups: [""], resources: ["secrets"] },
    { verbs: ["*"], apiGroups: ["apps"], resources: ["deployments"] },
  ];
  assert.equal(subjectCan({ rules }, { verb: "get", resource: "secrets" }), true);
  assert.equal(subjectCan({ rules }, { verb: "delete", resource: "secrets" }), false);
  assert.equal(subjectCan({ rules }, { verb: "delete", resource: "deployments", apiGroup: "apps" }), true);
  assert.equal(subjectCan({ rules }, { verb: "get", resource: "deployments", apiGroup: "" }), false);
});

test("cluster-admin, secrets, exec, impersonate, escalate flags are detected", () => {
  const report = buildKubernetesCiem({
    ...base,
    roles: [
      role("admin", [{ verbs: ["*"], apiGroups: ["*"], resources: ["*"] }], { clusterScoped: true }),
      role("secret-reader", [{ verbs: ["get", "list"], apiGroups: [""], resources: ["secrets"] }]),
      role("shell", [{ verbs: ["create"], apiGroups: [""], resources: ["pods/exec"] }]),
      role("imp", [{ verbs: ["impersonate"], apiGroups: [""], resources: ["users"] }]),
      role("esc", [{ verbs: ["escalate"], apiGroups: ["rbac.authorization.k8s.io"], resources: ["roles"] }]),
    ],
    bindings: [saBinding("admin", "a"), saBinding("secret-reader", "b"), saBinding("shell", "c"), saBinding("imp", "d"), saBinding("esc", "e")],
  });
  const flags = (name: string) => report.subjects.find((s) => s.subject.includes(`/${name}`))?.flags ?? [];
  assert.ok(flags("a").includes("cluster-admin"));
  assert.ok(flags("b").includes("secrets-access"));
  assert.ok(flags("c").includes("pod-exec"));
  assert.ok(flags("d").includes("impersonate"));
  assert.ok(flags("e").includes("escalate-or-bind"));
  // cluster-admin is the highest-risk subject.
  assert.equal(report.subjects[0]?.subject.includes("/a"), true);
  assert.equal(report.totals.clusterAdmins, 1);
  assert.equal(report.totals.secretsReaders, 1);
});

test("IRSA reach follows the ServiceAccount IAM role and classifies write access", () => {
  const iamRoles: CiemIamRole[] = [{
    arn: "arn:aws:iam::111122223333:role/app-role",
    statements: [
      { effect: "Allow", actions: ["s3:GetObject", "s3:DeleteObject"], resources: ["arn:aws:s3:::data/*"] },
      { effect: "Deny", actions: ["s3:DeleteObject"], resources: ["*"] },
    ],
  }];
  const serviceAccounts: CiemServiceAccount[] = [
    { namespace: "payments", name: "app", iamRoleArn: "arn:aws:iam::111122223333:role/app-role" },
  ];
  const report = buildKubernetesCiem({
    ...base,
    roles: [role("r", [{ verbs: ["get"], apiGroups: [""], resources: ["pods"] }])],
    bindings: [saBinding("r", "app")],
    serviceAccounts,
    iamRoles,
  });
  const app = report.subjects.find((s) => s.subject.includes("/app"));
  assert.ok(app?.awsReach !== null && app?.awsReach !== undefined);
  assert.equal(app?.awsReach?.roleArn, "arn:aws:iam::111122223333:role/app-role");
  // Deny removes s3:DeleteObject, leaving GetObject; GetObject is not "write".
  assert.deepEqual(app?.awsReach?.allowedActions, ["s3:GetObject"]);
  assert.equal(app?.awsReach?.hasWriteAccess, false);
  assert.ok(app?.flags.includes("aws-reachable"));
  assert.ok(!app?.flags.includes("aws-write"));
  assert.equal(report.totals.awsReachable, 1);
});

test("a write-capable IRSA role raises the aws-write flag and reach is unresolved when the policy is uncollected", () => {
  const writeReport = buildKubernetesCiem({
    ...base,
    roles: [role("r", [{ verbs: ["get"], apiGroups: [""], resources: ["pods"] }])],
    bindings: [saBinding("r", "app")],
    serviceAccounts: [{ namespace: "payments", name: "app", iamRoleArn: "arn:aws:iam::1:role/w" }],
    iamRoles: [{ arn: "arn:aws:iam::1:role/w", statements: [{ effect: "Allow", actions: ["dynamodb:PutItem"], resources: ["*"] }] }],
  });
  assert.ok(writeReport.subjects[0]?.flags.includes("aws-write"));
  assert.equal(writeReport.totals.awsWrite, 1);

  // IRSA annotation present but the IAM role policy was not collected: reach is
  // reported as unresolved (empty actions), never assumed empty of risk.
  const unresolved = buildKubernetesCiem({
    ...base,
    roles: [role("r", [{ verbs: ["get"], apiGroups: [""], resources: ["pods"] }])],
    bindings: [saBinding("r", "app")],
    serviceAccounts: [{ namespace: "payments", name: "app", iamRoleArn: "arn:aws:iam::1:role/missing" }],
    iamRoles: [],
  });
  assert.equal(unresolved.subjects[0]?.awsReach?.allowedActions.length, 0);
  assert.ok(unresolved.subjects[0]?.flags.includes("aws-reachable"));
});

test("bindings to unknown roles are ignored and output is deterministic", () => {
  const build = () => buildKubernetesCiem({
    ...base,
    roles: [role("r", [{ verbs: ["get"], apiGroups: [""], resources: ["pods"] }])],
    bindings: [saBinding("r", "app"), saBinding("ghost", "app")],
  });
  const report = build();
  assert.equal(report.subjects[0]?.boundRoles.length, 1);
  assert.deepEqual(build(), report);
});

test("no RBAC evidence yields no subjects", () => {
  const report = buildKubernetesCiem(base);
  assert.equal(report.subjects.length, 0);
  assert.equal(report.totals.subjects, 0);
  assert.match(report.disclaimer, /never assumed empty/u);
});
