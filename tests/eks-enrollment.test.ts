import assert from "node:assert/strict";
import test from "node:test";
import {
  EksEnrollmentError,
  createEksEnrollmentPlan,
} from "../lib/eks-enrollment.ts";

test("creates a non-secret exact-account EKS visibility enrollment plan", () => {
  const plan = createEksEnrollmentPlan({
    clusterName: "customer-production",
    region: "ap-south-1",
    accountId: "123456789012",
    customerRoleArn: "arn:aws:iam::123456789012:role/sutra/SutraCustomerReadOnlyRole",
  });
  assert.equal(plan.kubernetesGroup, "sutra:readers");
  assert.match(plan.commands.createAccessEntry, /--type STANDARD/u);
  assert.match(plan.commands.createAccessEntry, /--kubernetes-groups sutra:readers/u);
  assert.match(plan.commands.installVisibilityRole, /--atomic --wait$/u);
  assert.deepEqual(plan.safety, {
    secretRead: false,
    mutations: false,
    runtimeSensor: false,
    trivyReports: false,
  });
  assert.doesNotMatch(JSON.stringify(plan), /token|password|secretKey|kubeconfig/iu);
});

test("rejects cross-account, unsafe shell and unsupported partition inputs", () => {
  const base = {
    clusterName: "customer-production",
    region: "ap-south-1",
    accountId: "123456789012",
    customerRoleArn: "arn:aws:iam::123456789012:role/sutra/SutraCustomerReadOnlyRole",
  };
  for (const input of [
    { ...base, clusterName: "prod;curl evil" },
    { ...base, region: "ap-south-1;env" },
    { ...base, customerRoleArn: "arn:aws:iam::210987654321:role/sutra/Other" },
    { ...base, customerRoleArn: "arn:aws-cn:iam::123456789012:role/sutra/Role" },
    { ...base, region: "us-gov-west-1" },
  ]) {
    assert.throws(() => createEksEnrollmentPlan(input), EksEnrollmentError);
  }
});
