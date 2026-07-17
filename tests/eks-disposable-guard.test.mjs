import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const root = new URL("../", import.meta.url);

function environment() {
  return {
    ...process.env,
    AWS_REGION: "ap-south-1",
    SUTRA_AWS_ACCOUNT_ID: "738663485493",
    SUTRA_EKS_CLUSTER_NAME: "sutra-disposable-test",
    SUTRA_KUBERNETES_CONTEXT: "arn:aws:eks:ap-south-1:738663485493:cluster/sutra-disposable-test",
    SUTRA_DISPOSABLE_EXPIRES_AT: new Date(Date.now() + 60 * 60_000).toISOString(),
    SUTRA_DISPOSABLE_BUDGET_USD: "40",
    SUTRA_BUDGET_NOTIFICATION_EMAIL: "budget@example.com",
    SUTRA_ECR_REPOSITORY: "sutra/kubernetes-agent",
  };
}

test("disposable plan makes no AWS call and fixes the budget at USD 40", async () => {
  const { stdout } = await execute(process.execPath, [
    "scripts/eks-disposable-guard.mjs", "plan",
  ], {
    cwd: new URL("..", import.meta.url),
    env: { ...environment(), PATH: "" },
  });
  assert.match(stdout, /no AWS calls made/u);
  assert.match(stdout, /budget=USD 40/u);
  assert.match(stdout, /delete nodegroups; delete cluster/u);
});

test("AWS calls require execution, exact account/tag checks, and typed teardown confirmation", async () => {
  await assert.rejects(execute(process.execPath, [
    "scripts/eks-disposable-guard.mjs", "preflight",
  ], {
    cwd: new URL("..", import.meta.url),
    env: environment(),
  }), /--execute/u);
  const source = await readFile(new URL("scripts/eks-disposable-guard.mjs", root), "utf8");
  assert.match(source, /identity\.Account !== accountId/u);
  assert.match(source, /tags\["sutra:disposable"\] !== "true"/u);
  assert.match(source, /tags\["sutra:expires-at"\] !== expiration/u);
  assert.match(source, /confirmation !== cluster/u);
  assert.match(source, /nodegroup-deleted/u);
  assert.match(source, /cluster-deleted/u);
  assert.doesNotMatch(source, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/u);
});

test("ECR release is protected, OIDC-only, scanned, inventoried, and keyless-signed", async () => {
  const [workflow, role] = await Promise.all([
    readFile(new URL(".github/workflows/kubernetes-agent-release.yml", root), "utf8"),
    readFile(new URL("infrastructure/github-ecr-release-role.yaml", root), "utf8"),
  ]);
  assert.match(workflow, /environment: kubernetes-production-release/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /configure-aws-credentials@[a-f0-9]{40}/u);
  assert.match(workflow, /--password-stdin/u);
  assert.match(workflow, /aquasecurity\/trivy-action@[a-f0-9]{40}/u);
  assert.match(workflow, /download-syft@[a-f0-9]{40}/u);
  assert.match(workflow, /cosign sign --yes/u);
  assert.match(workflow, /cosign attest --yes/u);
  assert.doesNotMatch(workflow, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|pull_request:/u);
  assert.match(role, /ImageTagMutability: IMMUTABLE/u);
  assert.match(role, /environment:kubernetes-production-release/u);
  assert.match(role, /sts:AssumeRoleWithWebIdentity/u);
  assert.doesNotMatch(role, /\becr:\*/u);
  assert.doesNotMatch(role, /RepositoryPolicyText|Principal:\s*["']?\*["']?/u);
});
