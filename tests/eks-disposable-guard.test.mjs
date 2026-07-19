import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.match(stdout, /delete control-plane log group/u);
  assert.match(stdout, /SUTRA_DISPOSABLE_ROLE_STACKS/u);
  assert.match(stdout, /sutra\/notifications secrets/u);
  assert.match(stdout, /report remaining sutra:disposable resources and fail unless empty/u);
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
  assert.match(source, /"delete", "cluster"[\s\S]*"--wait"/u);
  assert.doesNotMatch(source, /--disable-eviction/u);
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
  assert.match(source, /"logs", "delete-log-group"/u);
  assert.match(source, /"resourcegroupstaggingapi", "get-resources"/u);
  assert.match(source, /Key=sutra:disposable,Values=true/u);
  assert.match(source, /Refusing to delete stack .+ without the sutra:disposable=true tag/u);
  assert.match(source, /startsWith\(NOTIFICATION_SECRET_PREFIX\)/u);
  assert.match(source, /--force-delete-without-recovery/u);
  assert.match(source, /Teardown incomplete: tagged disposable resources remain/u);
  assert.match(source, /"ecr", "describe-repositories"/u);
  assert.match(source, /"ecr", "list-tags-for-resource"/u);
  assert.match(source, /Refusing to delete ECR repository .+ without the sutra:disposable=true tag/u);
});

function fakeAwsScript(logPath, remainingResourcesJson) {
  return [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${logPath}'`,
    'case "$1 $2" in',
    '"sts get-caller-identity") echo \'{"Account":"738663485493"}\' ;;',
    '"eks describe-cluster") echo "An error occurred (ResourceNotFoundException)" 1>&2; exit 254 ;;',
    '"logs delete-log-group") echo "An error occurred (ResourceNotFoundException)" 1>&2; exit 254 ;;',
    '"ecr describe-repositories") echo "An error occurred (RepositoryNotFoundException)" 1>&2; exit 254 ;;',
    '"ecr delete-repository") echo "An error occurred (RepositoryNotFoundException)" 1>&2; exit 254 ;;',
    '"budgets delete-budget") echo "An error occurred (NotFoundException)" 1>&2; exit 254 ;;',
    '"cloudformation describe-stacks") echo \'{"Stacks":[{"Tags":[{"Key":"sutra:disposable","Value":"true"}]}]}\' ;;',
    '"cloudformation delete-stack") echo \'{}\' ;;',
    '"cloudformation wait") echo \'\' ;;',
    '"secretsmanager list-secrets") echo \'{"SecretList":[{"Name":"sutra/notifications/slack-demo","Tags":[{"Key":"sutra:disposable","Value":"true"}]},{"Name":"sutra/other-secret","Tags":[{"Key":"sutra:disposable","Value":"true"}]}]}\' ;;',
    '"secretsmanager delete-secret") echo \'{}\' ;;',
    `"resourcegroupstaggingapi get-resources") echo '${remainingResourcesJson}' ;;`,
    '*) echo "unexpected fake aws call: $*" 1>&2; exit 64 ;;',
    "esac",
    "",
  ].join("\n");
}

async function withFakeAws(remainingResourcesJson, execution) {
  const directory = await mkdtemp(join(tmpdir(), "sutra-guard-test-"));
  const logPath = join(directory, "aws-calls.log");
  try {
    await writeFile(logPath, "", "utf8");
    const awsPath = join(directory, "aws");
    await writeFile(awsPath, fakeAwsScript(logPath, remainingResourcesJson), "utf8");
    await chmod(awsPath, 0o755);
    return await execution({
      path: directory,
      readLog: async () => await readFile(logPath, "utf8"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("resumable teardown cleans role stacks, notification secrets, and audits remaining tagged resources", async () => {
  await withFakeAws('{"ResourceTagMappingList":[]}', async ({ path, readLog }) => {
    const { stdout } = await execute(process.execPath, [
      "scripts/eks-disposable-guard.mjs", "teardown",
      "--confirm", "sutra-disposable-test", "--execute",
    ], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...environment(),
        SUTRA_DISPOSABLE_ROLE_STACKS: "sutra-validation-customer-role",
        PATH: path,
      },
    });
    assert.match(stdout, /already absent; continuing cleanup/u);
    assert.match(stdout, /Remaining sutra:disposable resources: none/u);
    const log = await readLog();
    const calls = log.trim().split("\n");
    assert.match(log, /logs delete-log-group --log-group-name \/aws\/eks\/sutra-disposable-test\/cluster/u);
    assert.match(log, /cloudformation describe-stacks --stack-name sutra-validation-customer-role/u);
    assert.match(log, /cloudformation delete-stack --stack-name sutra-validation-customer-role/u);
    assert.match(log, /cloudformation wait stack-delete-complete --stack-name sutra-validation-customer-role/u);
    assert.match(log, /secretsmanager delete-secret --secret-id sutra\/notifications\/slack-demo --force-delete-without-recovery/u);
    assert.doesNotMatch(log, /delete-secret --secret-id sutra\/other-secret/u);
    assert.match(calls.at(-1) ?? "", /^resourcegroupstaggingapi get-resources/u);
    assert.doesNotMatch(log, /^eksctl/mu);
  });
});

function fakeAwsWithEcr(ecrTagsJson) {
  return [
    "#!/bin/sh",
    'case "$1 $2" in',
    '"sts get-caller-identity") echo \'{"Account":"738663485493"}\' ;;',
    '"eks describe-cluster") echo "An error occurred (ResourceNotFoundException)" 1>&2; exit 254 ;;',
    '"logs delete-log-group") echo "An error occurred (ResourceNotFoundException)" 1>&2; exit 254 ;;',
    '"ecr describe-repositories") echo \'{"repositories":[{"repositoryArn":"arn:aws:ecr:ap-south-1:738663485493:repository/sutra/kubernetes-agent"}]}\' ;;',
    `"ecr list-tags-for-resource") echo '${ecrTagsJson}' ;;`,
    '"ecr delete-repository") echo \'{}\' ;;',
    '"budgets delete-budget") echo "An error occurred (NotFoundException)" 1>&2; exit 254 ;;',
    '"secretsmanager list-secrets") echo \'{"SecretList":[]}\' ;;',
    '"resourcegroupstaggingapi get-resources") echo \'{"ResourceTagMappingList":[]}\' ;;',
    '*) echo "unexpected fake aws call: $*" 1>&2; exit 64 ;;',
    "esac",
    "",
  ].join("\n");
}

async function withCustomFakeAws(script, execution) {
  const directory = await mkdtemp(join(tmpdir(), "sutra-guard-ecr-"));
  try {
    const awsPath = join(directory, "aws");
    await writeFile(awsPath, script, "utf8");
    await chmod(awsPath, 0o755);
    return await execution(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("teardown refuses to delete an ECR repository that is not tagged sutra:disposable=true", async () => {
  const untagged = '{"tags":[{"Key":"team","Value":"platform"}]}';
  await withCustomFakeAws(fakeAwsWithEcr(untagged), async (path) => {
    try {
      await execute(process.execPath, [
        "scripts/eks-disposable-guard.mjs", "teardown",
        "--confirm", "sutra-disposable-test", "--execute",
      ], {
        cwd: new URL("..", import.meta.url),
        env: { ...environment(), PATH: path },
      });
      assert.fail("teardown must refuse an untagged ECR repository");
    } catch (error) {
      assert.match(String(error.stderr), /Refusing to delete ECR repository .+ without the sutra:disposable=true tag/u);
    }
  });
});

test("teardown deletes an ECR repository only after confirming the disposable tag", async () => {
  const tagged = '{"tags":[{"Key":"sutra:disposable","Value":"true"}]}';
  await withCustomFakeAws(fakeAwsWithEcr(tagged), async (path) => {
    const { stdout } = await execute(process.execPath, [
      "scripts/eks-disposable-guard.mjs", "teardown",
      "--confirm", "sutra-disposable-test", "--execute",
    ], {
      cwd: new URL("..", import.meta.url),
      env: { ...environment(), PATH: path },
    });
    assert.match(stdout, /Remaining sutra:disposable resources: none/u);
  });
});

test("teardown fails and prints each remaining tagged resource when cleanup is incomplete", async () => {
  const remaining = '{"ResourceTagMappingList":[{"ResourceARN":"arn:aws:ec2:ap-south-1:738663485493:volume/vol-0abc"}]}';
  await withFakeAws(remaining, async ({ path }) => {
    try {
      await execute(process.execPath, [
        "scripts/eks-disposable-guard.mjs", "teardown",
        "--confirm", "sutra-disposable-test", "--execute",
      ], {
        cwd: new URL("..", import.meta.url),
        env: { ...environment(), PATH: path },
      });
      assert.fail("teardown must fail while tagged resources remain");
    } catch (error) {
      assert.match(String(error.stderr), /Teardown incomplete: tagged disposable resources remain/u);
      assert.match(String(error.stdout), /Remaining sutra:disposable resources \(1\):/u);
      assert.match(String(error.stdout), /arn:aws:ec2:ap-south-1:738663485493:volume\/vol-0abc/u);
    }
  });
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
