import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const workflowDirectory = new URL("../.github/workflows/", import.meta.url);

function workflowFiles() {
  return readdirSync(workflowDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => ({
      name,
      source: readFileSync(new URL(name, workflowDirectory), "utf8"),
    }));
}

function runScripts(source) {
  const lines = source.split("\n");
  const scripts = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*(.*)$/u);
    if (!match) {
      continue;
    }

    const indentation = match[1].length;
    const declaration = match[2].trim();
    if (declaration && declaration !== "|" && declaration !== ">") {
      scripts.push(declaration);
      continue;
    }

    const block = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === "") {
        block.push(line);
        continue;
      }

      const lineIndentation = line.length - line.trimStart().length;
      if (lineIndentation <= indentation) {
        break;
      }
      block.push(line);
    }
    scripts.push(block.join("\n"));
  }

  return scripts;
}

test("third-party GitHub Actions are pinned to immutable commit SHAs", () => {
  for (const workflow of workflowFiles()) {
    const uses = [...workflow.source.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map(
      (match) => match[1],
    );

    for (const action of uses) {
      if (action.startsWith("./") || action.startsWith("docker://")) {
        continue;
      }
      assert.match(
        action,
        /^[^@]+@[0-9a-f]{40}$/u,
        `${workflow.name} must pin ${action} to a full commit SHA`,
      );
    }
  }
});

test("workflow inputs are never interpolated directly into shell scripts", () => {
  for (const workflow of workflowFiles()) {
    for (const script of runScripts(workflow.source)) {
      assert.doesNotMatch(
        script,
        /\$\{\{\s*inputs\./u,
        `${workflow.name} must pass inputs through environment variables and validate them`,
      );
    }
  }
});

test("CI runs slow gates independently and aggregates them fail-closed", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

  assert.match(ci, /^\s{2}quality:\s*$/mu);
  assert.match(ci, /^\s{2}integration:\s*$/mu);
  assert.match(ci, /^\s{2}build:\s*$/mu);
  assert.match(ci, /^\s{2}release-gate:\s*$/mu);
  assert.match(ci, /needs: \[quality, integration, build\]/u);
  assert.match(ci, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(ci, /QUALITY_RESULT: \$\{\{ needs\.quality\.result \}\}/u);
  assert.match(ci, /INTEGRATION_RESULT: \$\{\{ needs\.integration\.result \}\}/u);
  assert.match(ci, /BUILD_RESULT: \$\{\{ needs\.build\.result \}\}/u);
  assert.match(ci, /test "\$QUALITY_RESULT" = success/u);
  assert.match(ci, /test "\$INTEGRATION_RESULT" = success/u);
  assert.match(ci, /test "\$BUILD_RESULT" = success/u);
});

test("the in-cluster security gate runs with an immutable root filesystem", () => {
  const manifest = readFileSync(
    new URL("../deploy/ci/kubernetes-gate-job.yaml", import.meta.url),
    "utf8",
  );

  assert.match(manifest, /readOnlyRootFilesystem:\s*true/u);
  assert.doesNotMatch(manifest, /readOnlyRootFilesystem:\s*false/u);
  assert.doesNotMatch(
    manifest,
    /\bapt-get\b/u,
    "a read-only gate must not attempt to mutate the base image",
  );
});

test("EC2 releases use OIDC, bounded source gates, immutable images, exact-host SSM and public verification", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ec2-private-beta-release.yml", import.meta.url),
    "utf8",
  );
  const role = readFileSync(
    new URL("../infrastructure/github-ec2-release-role.yaml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /^\s{2}(push|pull_request):\s*$/mu);
  assert.doesNotMatch(
    workflow,
    /^\s{4}environment:\s*$/mu,
    "GitHub Free private repositories cannot use deployment environments",
  );
  for (const variable of ["AWS_ACCOUNT_ID", "AWS_REGION", "AWS_ROLE_ARN", "EC2_INSTANCE_ID"]) {
    assert.match(workflow, new RegExp(`\\$\\{\\{ vars\\.${variable} \\}\\}`));
  }
  assert.match(workflow, /GITHUB_REF.+refs\/heads\/main/u);
  assert.doesNotMatch(workflow, /GITHUB_REF_PROTECTED/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /allowed-account-ids:/u);
  assert.match(workflow, /role-duration-seconds: 3600/u);
  assert.match(workflow, /#RELEASE_REASON.+-le 100/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /pnpm install --frozen-lockfile/u);
  assert.match(workflow, /pnpm security:secrets/u);
  assert.match(workflow, /pnpm typecheck/u);
  assert.match(workflow, /pnpm typecheck:collector/u);
  assert.match(workflow, /pnpm lint/u);
  assert.match(workflow, /pnpm test:templates/u);
  assert.match(workflow, /deploy\/ec2\/validate-ops\.sh/u);
  assert.match(workflow, /imageTagMutability/u);
  assert.match(workflow, /tag_mutability.+IMMUTABLE/u);
  assert.match(workflow, /imageScanningConfiguration\.scanOnPush/u);
  assert.match(workflow, /--provenance=mode=max/u);
  assert.match(workflow, /--sbom=true/u);
  assert.match(workflow, /aquasecurity\/trivy-action@[a-f0-9]{40}/u);
  assert.match(workflow, /sutra\/app@sha256:\[a-f0-9\]\{64\}/u);
  assert.match(workflow, /aws ssm get-connection-status/u);
  assert.match(workflow, /aws ssm send-command/u);
  assert.match(workflow, /aws ssm get-command-invocation/u);
  assert.match(workflow, /\/api\/healthz \/login \/status/u);
  assert.doesNotMatch(
    workflow,
    /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|aws ssm start-session|AWS-RunShellScript|aws ec2 (?:start|stop)-instances/u,
  );

  assert.match(role, /token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com/u);
  assert.match(
    role,
    /token\.actions\.githubusercontent\.com:sub: repo:ydsveluvolu2996\/Sutra:ref:refs\/heads\/main/u,
  );
  assert.doesNotMatch(role, /GitHubRepository|ReleaseEnvironment|:environment:/u);
  assert.match(role, /Action: ssm:GetConnectionStatus/u);
  assert.match(role, /Action: ssm:SendCommand/u);
  assert.match(role, /Sutra-DeployImmutableRelease/u);
  assert.match(role, /interpolationType: ENV_VAR/u);
  assert.match(role, /\/usr\/local\/sbin\/sutra-release-update/u);
  assert.match(role, /instance\/\$\{TargetInstanceId\}/u);
  assert.match(role, /Action: ssm:GetCommandInvocation/u);
  assert.match(role, /repository\/\$\{AppRepositoryName\}/u);
  assert.doesNotMatch(
    role,
    /ssm:StartSession|ec2:(?:Start|Stop)Instances|ecr:DeleteRepository|ecr:BatchDeleteImage|iam:PassRole/u,
  );
});

test("private-beta host start and stop remain explicit, SSO-only, and exact-instance bounded", () => {
  const control = readFileSync(
    new URL("../deploy/ec2/manual-host-control.sh", import.meta.url),
    "utf8",
  );
  const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");

  assert.match(control, /manual-host-control\.sh <start\|stop\|status>/u);
  assert.match(control, /EXPECTED_ACCOUNT="738663485493"/u);
  assert.match(control, /INSTANCE_ID="i-0a7af7b477174a14b"/u);
  assert.match(control, /SUTRA_AWS_ADMIN_PROFILE:-sutra-administrator/u);
  assert.match(control, /aws sso login --profile/u);
  assert.match(control, /AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN/u);
  assert.match(control, /ec2 start-instances --instance-ids "\$INSTANCE_ID"/u);
  assert.match(control, /ec2 stop-instances --instance-ids "\$INSTANCE_ID"/u);
  assert.doesNotMatch(control, /scheduler|cron\(|at\s/u);
  assert.match(packageJson, /"cloud:status": "bash deploy\/ec2\/manual-host-control\.sh status"/u);
  assert.match(packageJson, /"cloud:start": "bash deploy\/ec2\/manual-host-control\.sh start"/u);
  assert.match(packageJson, /"cloud:stop": "bash deploy\/ec2\/manual-host-control\.sh stop"/u);
});
