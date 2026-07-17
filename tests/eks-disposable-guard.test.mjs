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
    AWS_PROFILE: "sutra-administrator",
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
  assert.match(stdout, /one on-demand t3\.large node/u);
  assert.match(stdout, /no NAT gateway; no SSH; IMDSv2/u);
  assert.match(stdout, /SUTRA_VALIDATOR_CIDR \/32/u);
  assert.match(stdout, /delete cluster and nodegroup stacks/u);
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
  assert.match(source, /update-termination-protection/u);
  assert.match(source, /"delete", "cluster"/u);
  assert.match(source, /"--wait", "--disable-eviction"/u);
  assert.match(source, /publicAccessCIDRs/u);
  assert.match(source, /privateAccess: true/u);
  assert.match(source, /desiredCapacity: 1/u);
  assert.match(source, /maxSize: 1/u);
  assert.match(source, /disableIMDSv1: true/u);
  assert.match(source, /volumeEncrypted: true/u);
  assert.match(source, /put-retention-policy/u);
  assert.match(source, /IncludeCredit: false/u);
  assert.match(source, /gateway: Disable/u);
  assert.doesNotMatch(source, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/u);
});

test("cluster creation requires an exact validator address and explicit execution", async () => {
  await assert.rejects(execute(process.execPath, [
    "scripts/eks-disposable-guard.mjs", "create", "--execute",
  ], {
    cwd: new URL("..", import.meta.url),
    env: environment(),
  }), /SUTRA_VALIDATOR_CIDR/u);
  await assert.rejects(execute(process.execPath, [
    "scripts/eks-disposable-guard.mjs", "create",
  ], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...environment(),
      SUTRA_VALIDATOR_CIDR: "203.0.113.10/32",
    },
  }), /--execute/u);
  await assert.rejects(execute(process.execPath, [
    "scripts/eks-disposable-guard.mjs", "create", "--execute",
  ], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...environment(),
      SUTRA_VALIDATOR_CIDR: "999.0.0.1/32",
    },
  }), /SUTRA_VALIDATOR_CIDR/u);
});

test("ECR release is protected, OIDC-only, scanned, inventoried, and keyless-signed", async () => {
  const [workflow, provider, role] = await Promise.all([
    readFile(new URL(".github/workflows/kubernetes-agent-release.yml", root), "utf8"),
    readFile(new URL("infrastructure/github-oidc-provider.yaml", root), "utf8"),
    readFile(new URL("infrastructure/github-ecr-release-role.yaml", root), "utf8"),
  ]);
  assert.match(workflow, /environment: kubernetes-production-release/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /GITHUB_REF_PROTECTED.+true/u);
  assert.match(workflow, /GITHUB_REF.+refs\/heads\/main/u);
  assert.match(workflow, /allowed-account-ids:/u);
  assert.match(workflow, /role-duration-seconds: 900/u);
  assert.match(workflow, /AGENT_ECR_REPOSITORY/u);
  assert.match(workflow, /FALCO_GATEWAY_ECR_REPOSITORY/u);
  assert.doesNotMatch(workflow, /\bECR_REPOSITORY\b/u);
  assert.match(workflow, /services\/kubernetes-collector\/Dockerfile\.agent/u);
  assert.match(workflow, /services\/falco-signing-gateway\/Dockerfile/u);
  assert.equal(workflow.match(/--build-arg "NODE_IMAGE=\$\{NODE_IMAGE\}"/gu)?.length, 2);
  assert.match(
    workflow,
    /NODE_IMAGE\}" == "gcr\.io\/distroless\/nodejs22-debian13:nonroot@sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50"/u,
  );
  assert.equal(workflow.match(/aquasecurity\/trivy-action@[a-f0-9]{40}/gu)?.length, 2);
  assert.match(workflow, /sutra-kubernetes-agent\.spdx\.json/u);
  assert.match(workflow, /sutra-falco-signing-gateway\.spdx\.json/u);
  assert.equal(workflow.match(/cosign sign --yes/gu)?.length, 2);
  assert.equal(workflow.match(/cosign attest --yes/gu)?.length, 2);
  assert.match(workflow, /sutra-kubernetes-runtime-release\.json/u);
  assert.match(workflow, /falcoSigningGateway/u);
  assert.match(workflow, /GITHUB_WORKFLOW_REF/u);
  assert.match(workflow, /tag_mutability.+IMMUTABLE/u);
  assert.match(workflow, /imageScanningConfiguration\.scanOnPush/u);
  assert.match(workflow, /configure-aws-credentials@[a-f0-9]{40}/u);
  assert.match(workflow, /--password-stdin/u);
  assert.match(workflow, /aquasecurity\/trivy-action@[a-f0-9]{40}/u);
  assert.match(workflow, /download-syft@[a-f0-9]{40}/u);
  assert.match(workflow, /cosign sign --yes/u);
  assert.match(workflow, /cosign attest --yes/u);
  assert.doesNotMatch(workflow, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|pull_request:/u);
  assert.match(provider, /Type: AWS::IAM::OIDCProvider/u);
  assert.match(provider, /Url: https:\/\/token\.actions\.githubusercontent\.com/u);
  assert.match(provider, /- sts\.amazonaws\.com/u);
  assert.doesNotMatch(provider, /ThumbprintList/u);
  assert.match(role, /ImageTagMutability: IMMUTABLE/u);
  assert.equal(role.match(/Type: AWS::ECR::Repository/gu)?.length, 2);
  assert.match(role, /DistinctRuntimeRepositories:/u);
  assert.match(role, /AgentEcrRepositoryName:/u);
  assert.match(role, /FalcoGatewayEcrRepositoryName:/u);
  assert.match(role, /AgentRepository\.Arn/u);
  assert.match(role, /FalcoGatewayRepository\.Arn/u);
  assert.match(role, /DeletionPolicy: Retain/u);
  assert.match(role, /environment:\$\{ReleaseEnvironment\}/u);
  assert.match(role, /token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com/u);
  assert.match(role, /sts:AssumeRoleWithWebIdentity/u);
  assert.match(role, /ecr:BatchGetImage/u);
  assert.match(role, /tagStatus":"untagged"/u);
  assert.doesNotMatch(role, /ecr:ListImages/u);
  assert.doesNotMatch(role, /\becr:\*/u);
  assert.doesNotMatch(role, /RepositoryPolicyText|Principal:\s*["']?\*["']?/u);
});
