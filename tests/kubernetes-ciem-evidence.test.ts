import assert from "node:assert/strict";
import test from "node:test";
import { deriveCiemInputs } from "../lib/kubernetes-ciem-evidence.ts";
import { buildKubernetesCiem } from "../lib/kubernetes-ciem.ts";

type ResourceArg = Parameters<typeof deriveCiemInputs>[0][number];
function resource(over: Record<string, unknown>): ResourceArg {
  return {
    resourceKey: "rk", service: "kubernetes", resourceType: "kubernetes",
    arn: null, name: null, configuration: {},
    ...over,
  } as unknown as ResourceArg;
}

test("derives roles, bindings, service accounts and IAM roles from CMDB resources end to end", () => {
  const inputs = deriveCiemInputs([
    resource({
      resourceKey: "r1", name: "payments-reader",
      configuration: { kind: "Role", namespace: "payments", rules: [{ verbs: ["get", "list"], apiGroups: [""], resources: ["secrets"] }] },
    }),
    resource({
      resourceKey: "rb1",
      configuration: {
        kind: "RoleBinding", namespace: "payments", roleRefKind: "Role", roleRefName: "payments-reader",
        subjects: [{ kind: "ServiceAccount", namespace: "payments", name: "app" }],
      },
    }),
    resource({
      resourceKey: "sa1", name: "app",
      configuration: { kind: "ServiceAccount", namespace: "payments", metadata: { name: "app", annotations: { "eks.amazonaws.com/role-arn": "arn:aws:iam::1:role/app" } } },
    }),
    resource({
      resourceKey: "iam1", service: "iam", resourceType: "iam.role", arn: "arn:aws:iam::1:role/app", name: "app",
      configuration: { policyDocument: { Statement: [{ Effect: "Allow", Action: ["s3:PutObject"], Resource: ["*"] }] } },
    }),
  ]);
  assert.equal(inputs.roles.length, 1);
  assert.equal(inputs.roles[0]?.id, "role:payments/payments-reader");
  assert.equal(inputs.bindings.length, 1);
  assert.equal(inputs.bindings[0]?.roleId, "role:payments/payments-reader");
  assert.equal(inputs.serviceAccounts[0]?.iamRoleArn, "arn:aws:iam::1:role/app");
  assert.equal(inputs.iamRoles[0]?.statements[0]?.actions[0], "s3:PutObject");

  // The derived inputs resolve through the engine to a real entitlement.
  const report = buildKubernetesCiem(inputs);
  const app = report.subjects.find((s) => s.subject.includes("/app"));
  assert.ok(app !== undefined);
  assert.ok(app.flags.includes("secrets-access"));
  assert.ok(app.flags.includes("aws-write"));
});

test("clusterrolebinding resolves to the cluster role id", () => {
  const inputs = deriveCiemInputs([
    resource({ resourceKey: "cr", name: "admin", configuration: { kind: "ClusterRole", rules: [{ verbs: ["*"], apiGroups: ["*"], resources: ["*"] }] } }),
    resource({ resourceKey: "crb", configuration: { kind: "ClusterRoleBinding", roleRefKind: "ClusterRole", roleRefName: "admin", subjects: [{ kind: "ServiceAccount", namespace: "kube-system", name: "ops" }] } }),
  ]);
  assert.equal(inputs.roles[0]?.id, "clusterrole:admin");
  assert.equal(inputs.bindings[0]?.roleId, "clusterrole:admin");
  const report = buildKubernetesCiem(inputs);
  assert.ok(report.subjects[0]?.flags.includes("cluster-admin"));
});

test("missing rules, subjects, or policy degrade to empty, never crash or invent", () => {
  const inputs = deriveCiemInputs([
    resource({ resourceKey: "r", name: "empty", configuration: { kind: "Role", namespace: "x" } }),
    resource({ resourceKey: "rb", configuration: { kind: "RoleBinding", namespace: "x", roleRefName: "empty" } }),
    resource({ resourceKey: "iam", service: "iam", resourceType: "iam.role", arn: "arn:aws:iam::1:role/x", configuration: {} }),
  ]);
  assert.deepEqual(inputs.roles[0]?.rules, []);
  assert.equal(inputs.bindings.length, 0);
  assert.deepEqual(inputs.iamRoles[0]?.statements, []);
  assert.deepEqual(buildKubernetesCiem(inputs).subjects, []);
});

test("empty resource set yields empty inputs", () => {
  const inputs = deriveCiemInputs([]);
  assert.deepEqual(inputs, { roles: [], bindings: [], serviceAccounts: [], iamRoles: [] });
});
