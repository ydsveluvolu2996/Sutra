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

test("CI reuses only exact successful PR verification and otherwise runs consolidated gates", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

  assert.match(ci, /^\s{2}reuse-pr-gate:\s*$/mu);
  assert.match(ci, /^\s{2}quality:\s*$/mu);
  assert.match(ci, /^\s{2}integration:\s*$/mu);
  assert.match(ci, /^\s{2}release-gate:\s*$/mu);
  assert.doesNotMatch(ci, /^\s{2}(test|build):\s*$/mu);
  assert.match(ci, /needs: \[reuse-pr-gate, quality, integration\]/u);
  assert.match(ci, /repos\/\$\{REPOSITORY\}\/commits\/\$\{COMMIT_SHA\}\/pulls/u);
  assert.match(ci, /actions\/workflows\/ci\.yml\/runs\?event=pull_request&head_sha=/u);
  assert.match(ci, /\.merge_commit_sha == \$commit_sha/u);
  assert.match(ci, /\.base\.ref == "main"/u);
  assert.match(ci, /\.head_sha == \$head_sha/u);
  assert.match(ci, /\.head_branch == \$head_branch/u);
  assert.match(ci, /\.head_repository\.full_name == \$head_repository/u);
  assert.match(ci, /\.display_title == \$pr_title/u);
  assert.match(ci, /\.conclusion == "success"/u);
  assert.match(ci, /\.created_at >= \$pr_created_at/u);
  assert.match(ci, /\.updated_at <= \$merged_at/u);
  assert.match(ci, /lookup unavailable; full gate required/u);
  assert.match(ci, /node scripts\/ci-test-shard\.mjs\s*$/mu);
  assert.doesNotMatch(ci, /node scripts\/ci-test-shard\.mjs --shard/u);
  assert.match(ci, /trivy fs .*--severity HIGH,CRITICAL/u);
  assert.match(ci, /trivy config .*--severity HIGH,CRITICAL/u);
  assert.match(ci, /node scripts\/pipeline-scan\.mjs --fail-on high/u);
  assert.match(ci, /pnpm build/u);
  assert.match(ci, /pnpm test:rendered/u);
  assert.match(ci, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(ci, /PROVENANCE_RESULT: \$\{\{ needs\.reuse-pr-gate\.result \}\}/u);
  assert.match(ci, /REUSE: \$\{\{ needs\.reuse-pr-gate\.outputs\.reuse \}\}/u);
  assert.match(ci, /QUALITY_RESULT: \$\{\{ needs\.quality\.result \}\}/u);
  assert.match(ci, /INTEGRATION_RESULT: \$\{\{ needs\.integration\.result \}\}/u);
  assert.match(ci, /test "\$PROVENANCE_RESULT" = success/u);
  assert.match(ci, /if \[\[ "\$REUSE" == "true" \]\]/u);
  assert.equal(ci.match(/test "\$QUALITY_RESULT" = (?:skipped|success)/gu)?.length, 2);
  assert.equal(ci.match(/test "\$INTEGRATION_RESULT" = (?:skipped|success)/gu)?.length, 2);
});

test("expensive scheduled analysis is weekly or manual", () => {
  const codeql = readFileSync(new URL("../.github/workflows/codeql.yml", import.meta.url), "utf8");
  const endurance = readFileSync(new URL("../.github/workflows/nightly.yml", import.meta.url), "utf8");

  assert.doesNotMatch(codeql, /^\s{2}(pull_request|push):\s*$/mu);
  assert.match(codeql, /cron: "23 3 \* \* 1"/u);
  assert.match(codeql, /^\s{2}workflow_dispatch:\s*$/mu);
  assert.match(endurance, /cron: "0 4 \* \* 6"/u);
  assert.match(endurance, /^\s{2}workflow_dispatch:\s*$/mu);
});

test("the quota-independent EC2 release preserves exact-digest production gates", () => {
  const release = readFileSync(
    new URL("../scripts/manual-ec2-release.sh", import.meta.url),
    "utf8",
  );
  const sourceGate = release.indexOf("Running the complete source and deployment gate on the detached release commit");
  const candidateBuild = release.indexOf("Building and pushing an immutable candidate");
  const exactScan = release.indexOf("Scanning the exact candidate digest");
  const promotion = release.indexOf("Promoting only the scanned OCI manifest");
  const deployment = release.indexOf("Deploying the exact promoted digest");
  const verification = release.indexOf("Verifying the selected digest and public customer paths");

  assert.ok(
    sourceGate > 0
      && candidateBuild > sourceGate
      && exactScan > candidateBuild
      && promotion > exactScan
      && deployment > promotion
      && verification > deployment,
    "source, build, scan, promotion, deployment and verification must remain ordered",
  );
  assert.match(release, /Static or injected AWS credentials are rejected/u);
  assert.match(release, /git branch --show-current.+main/u);
  assert.match(release, /git status --porcelain=v1 --untracked-files=all/u);
  assert.match(release, /COMMIT_SHA.+REMOTE_SHA/u);
  assert.match(release, /git worktree add --quiet --detach "\$source_root" "\$COMMIT_SHA"/u);
  assert.match(release, /EXPECTED_ACCOUNT="738663485493"/u);
  assert.match(release, /imageTagMutability/u);
  assert.match(release, /tag_mutability.+IMMUTABLE/u);
  assert.match(release, /deploy\/ec2\/ecr-lifecycle-policy\.json/u);
  assert.match(release, /pnpm install --frozen-lockfile/u);
  assert.match(release, /node scripts\/ci-test-shard\.mjs/u);
  assert.match(release, /pnpm db:postgres:test/u);
  assert.match(release, /pnpm build/u);
  assert.match(release, /--provenance=mode=max/u);
  assert.match(release, /--sbom=true/u);
  assert.match(release, /trivy image --pkg-types os,library/u);
  assert.match(release, /application\/vnd\.oci\.image\.index\.v1\+json/u);
  assert.match(release, /vnd\.docker\.reference\.type.+attestation-manifest/u);
  assert.match(release, /manifest_digest="sha256:\$\(printf/u);
  assert.match(release, /aws_cli ecr put-image/u);
  assert.match(release, /--image-digest "\$IMAGE_DIGEST"/u);
  assert.match(release, /INSTANCE_ID="i-0a7af7b477174a14b"/u);
  assert.match(release, /RELEASE_DOCUMENT="Sutra-DeployImmutableRelease"/u);
  assert.match(release, /aws_cli ssm get-connection-status/u);
  assert.match(release, /aws_cli ssm send-command/u);
  assert.match(release, /aws_cli ssm get-command-invocation/u);
  assert.match(release, /x-sutra-release-image:/u);
  assert.match(release, /\/api\/turnstile\/config/u);
  assert.match(release, /\/\.well-known\/security\.txt/u);
  assert.match(release, /\.sutra\/manual-releases/u);
  assert.doesNotMatch(
    release,
    /AWS-RunShellScript|aws_cli ec2 (?:start|stop)-instances|--skip-(?:test|scan)/u,
  );
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
  const candidateBuildStart = workflow.indexOf("Build and push an immutable scan candidate");
  const scanStart = workflow.indexOf("Scan the exact application digest");
  const promotionStart = workflow.indexOf("Promote the scanned digest to a retained release tag");
  const ssmStart = workflow.indexOf("Require the manually started host to be online in SSM");
  assert.ok(
    candidateBuildStart > 0
      && scanStart > candidateBuildStart
      && promotionStart > scanStart
      && ssmStart > promotionStart,
    "a candidate must pass the exact-digest scan and promotion before any SSM deployment",
  );
  const candidateBuild = workflow.slice(candidateBuildStart, scanStart);
  const promotion = workflow.slice(promotionStart, ssmStart);

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
  assert.match(workflow, /aws ecr get-lifecycle-policy/u);
  assert.match(workflow, /deploy\/ec2\/ecr-lifecycle-policy\.json/u);
  assert.match(workflow, /actual_lifecycle.+expected_lifecycle/u);
  assert.match(workflow, /--provenance=mode=max/u);
  assert.match(workflow, /--sbom=true/u);
  assert.match(candidateBuild, /candidate_tag="candidate-\$\{GITHUB_SHA\}-run-/u);
  assert.match(candidateBuild, /release_tag="sha-\$\{GITHUB_SHA\}-run-/u);
  assert.match(candidateBuild, /--tag "\$\{candidate_image\}"/u);
  assert.doesNotMatch(candidateBuild, /--tag "\$\{release_tag\}"/u);
  assert.match(workflow, /aquasecurity\/trivy-action@[a-f0-9]{40}/u);
  assert.match(promotion, /aws ecr batch-get-image/u);
  assert.match(promotion, /aws ecr put-image/u);
  assert.match(promotion, /application\/vnd\.oci\.image\.index\.v1\+json/u);
  assert.match(promotion, /vnd\.docker\.reference\.type.+attestation-manifest/u);
  assert.match(promotion, /manifest_digest="sha256:\$\(printf/u);
  assert.match(promotion, /--image-digest "\$\{DIGEST\}"/u);
  assert.match(promotion, /\[\[ "\$\{promoted_digest\}" == "\$\{DIGEST\}" \]\]/u);
  assert.match(promotion, /\[\[ "\$\{retained_digest\}" == "\$\{DIGEST\}" \]\]/u);
  assert.match(workflow, /sutra\/app@sha256:\[a-f0-9\]\{64\}/u);
  assert.match(workflow, /aws ssm get-connection-status/u);
  assert.match(workflow, /aws ssm send-command/u);
  assert.match(workflow, /aws ssm get-command-invocation/u);
  assert.match(workflow, /\/about \/contact \/security \/privacy \/terms \/status \/robots\.txt \/sitemap\.xml/u);
  assert.match(workflow, /Sitemap: \$\{PUBLIC_ORIGIN\}\/sitemap\.xml/u);
  assert.match(workflow, /<loc>\$\{PUBLIC_ORIGIN\}\//u);
  assert.match(workflow, /x-sutra-release-image:/u);
  assert.match(workflow, /served_image.+IMAGE_REF/u);
  assert.match(workflow, /x-robots-tag:.*noindex/u);
  assert.match(workflow, /apex_code.+308.+apex_location.+PUBLIC_ORIGIN/u);
  assert.doesNotMatch(
    workflow,
    /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|aws ssm start-session|AWS-RunShellScript|aws ec2 (?:start|stop)-instances/u,
  );

  assert.match(role, /token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com/u);
  assert.match(
    role,
    /token\.actions\.githubusercontent\.com:sub: repo:ydsveluvolu2996@229068958\/Sutra@1301833628:ref:refs\/heads\/main/u,
  );
  assert.doesNotMatch(role, /token\.actions\.githubusercontent\.com:sub:.*\*/u);
  assert.doesNotMatch(role, /GitHubRepository|ReleaseEnvironment|:environment:/u);
  assert.match(role, /Action: ssm:GetConnectionStatus/u);
  assert.match(role, /Action: ssm:SendCommand/u);
  assert.match(role, /Sutra-DeployImmutableRelease/u);
  assert.match(role, /interpolationType: ENV_VAR/u);
  assert.match(role, /\/usr\/local\/sbin\/sutra-release-update/u);
  assert.match(role, /instance\/\$\{TargetInstanceId\}/u);
  assert.match(role, /Action: ssm:GetCommandInvocation/u);
  assert.match(role, /repository\/\$\{AppRepositoryName\}/u);
  assert.match(role, /- ecr:BatchGetImage/u);
  assert.match(role, /- ecr:GetLifecyclePolicy/u);
  assert.match(role, /- ecr:PutImage/u);
  assert.doesNotMatch(
    role,
    /ssm:StartSession|ec2:(?:Start|Stop)Instances|ecr:DeleteRepository|ecr:BatchDeleteImage|iam:PassRole/u,
  );
});

test("ECR lifecycle keeps three validated releases and expires only lower-priority candidates", () => {
  const policy = JSON.parse(readFileSync(
    new URL("../deploy/ec2/ecr-lifecycle-policy.json", import.meta.url),
    "utf8",
  ));
  const readme = readFileSync(new URL("../deploy/ec2/README.md", import.meta.url), "utf8");
  const delivery = readFileSync(
    new URL("../docs/ec2-continuous-delivery.md", import.meta.url),
    "utf8",
  );

  assert.equal(policy.rules.length, 3);
  assert.deepEqual(policy.rules.map((rule) => rule.rulePriority), [1, 2, 3]);
  const [validated, candidate, untagged] = policy.rules;
  assert.deepEqual(validated.selection, {
    tagStatus: "tagged",
    tagPrefixList: ["sha-"],
    countType: "imageCountMoreThan",
    countNumber: 3,
  });
  assert.deepEqual(candidate.selection, {
    tagStatus: "tagged",
    tagPrefixList: ["candidate-"],
    countType: "sinceImagePushed",
    countUnit: "days",
    countNumber: 1,
  });
  assert.deepEqual(untagged.selection, {
    tagStatus: "untagged",
    countType: "sinceImagePushed",
    countUnit: "days",
    countNumber: 14,
  });
  assert.equal(validated.action.type, "expire");
  assert.equal(candidate.action.type, "expire");
  assert.equal(untagged.action.type, "expire");
  assert.ok(validated.rulePriority < candidate.rulePriority);
  assert.match(readme, /file:\/\/deploy\/ec2\/ecr-lifecycle-policy\.json/u);
  assert.match(delivery, /failed scans never consume the three-release retention window/u);
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
