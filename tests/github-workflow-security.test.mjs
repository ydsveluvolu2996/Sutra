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
  const scannerIgnore = readFileSync(
    new URL("../.trivyignore.scanner-image", import.meta.url),
    "utf8",
  );

  assert.match(ci, /^\s{2}reuse-pr-gate:\s*$/mu);
  assert.match(ci, /^\s{2}quality:\s*$/mu);
  assert.match(ci, /^\s{2}integration:\s*$/mu);
  assert.match(ci, /^\s{2}scanner-image:\s*$/mu);
  assert.match(ci, /^\s{2}release-gate:\s*$/mu);
  assert.doesNotMatch(ci, /^\s{2}(test|build):\s*$/mu);
  assert.match(ci, /^\s{2}tests:\s*$/mu);
  assert.match(ci, /needs: \[reuse-pr-gate, quality, tests, integration, scanner-image\]/u);
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
  // The offline PR-gate suite must run as six balanced shards on separate
  // runners; the unsharded single-runner invocation must never come back.
  assert.match(
    ci,
    /node scripts\/ci-test-shard\.mjs --shard \$\{\{ matrix\.shard \}\}\/6\s*$/mu,
    "CI must run the offline PR-gate suite as sharded matrix jobs",
  );
  assert.doesNotMatch(
    ci,
    /node scripts\/ci-test-shard\.mjs\s*$/mu,
    "CI must not run the whole PR-gate suite on one runner",
  );
  assert.match(ci, /shard: \[1, 2, 3, 4, 5, 6\]/u);
  assert.equal(
    ci.match(/node scripts\/ci-test-shard\.mjs --shard/gu)?.length,
    1,
    "the sharded PR-gate suite must be invoked from exactly one job",
  );
  const shardMatrix = /matrix:\s*\n\s*shard: \[([^\]]+)\]/u.exec(ci);
  assert.ok(shardMatrix, "the tests job must declare a shard matrix");
  assert.deepEqual(
    shardMatrix[1].split(",").map((value) => value.trim()),
    ["1", "2", "3", "4", "5", "6"],
    "the shard matrix must cover exactly six shards, matching --shard N/6",
  );
  assert.match(ci, /fail-fast: false/u);
  // Files inside a shard share process/global state, so the runner must never
  // execute them concurrently. Parallelism comes only from separate runners.
  const shardScript = readFileSync(
    new URL("../scripts/ci-test-shard.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    shardScript,
    /"--test", "--test-concurrency=1"/u,
    "each shard must still run its own files serially",
  );
  assert.doesNotMatch(shardScript, /--test-concurrency=(?!1\b)\d+/u);
  assert.match(ci, /node scripts\/pipeline-scan\.mjs --fail-on high/u);
  const pipelineScan = readFileSync(
    new URL("../scripts/pipeline-scan.mjs", import.meta.url),
    "utf8",
  );
  assert.match(pipelineScan, /"fs", "--quiet", "--scanners", "vuln"/u);
  assert.match(pipelineScan, /"config", "--quiet", "--severity"/u);
  assert.match(pipelineScan, /required scanner unavailable: trivy/u);
  assert.match(ci, /pnpm build/u);
  assert.match(ci, /pnpm build:agentless-scanner/u);
  assert.equal(
    [...ci.matchAll(/services\/agentless-scanner\/Dockerfile/gu)].length,
    1,
    "CI must build the scanner Dockerfile once",
  );
  assert.match(ci, /--platform linux\/amd64/u);
  assert.match(ci, /--load/u);
  assert.match(ci, /--cache-from type=gha,scope=sutra-ci-agentless-scanner/u);
  assert.match(ci, /--cache-to type=gha,mode=max,scope=sutra-ci-agentless-scanner/u);
  assert.match(ci, /Scan every High and Critical scanner-image finding/u);
  assert.match(ci, /scan-type: image/u);
  assert.match(ci, /trivyignores: \.trivyignore\.scanner-image/u);
  assert.doesNotMatch(
    scannerIgnore,
    /^\s*(?!#)\S+/mu,
    "the scanner-image gate must not suppress any vulnerability identifier",
  );
  assert.match(ci, /severity: CRITICAL,HIGH/u);
  assert.match(ci, /ignore-unfixed: false/u);
  assert.match(ci, /SCANNER_IMAGE_RESULT: \$\{\{ needs\.scanner-image\.result \}\}/u);
  assert.match(ci, /test "\$SCANNER_IMAGE_RESULT" = success/u);
  assert.match(ci, /pnpm test:rendered/u);
  assert.match(ci, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(ci, /PROVENANCE_RESULT: \$\{\{ needs\.reuse-pr-gate\.result \}\}/u);
  assert.match(ci, /REUSE: \$\{\{ needs\.reuse-pr-gate\.outputs\.reuse \}\}/u);
  assert.match(ci, /QUALITY_RESULT: \$\{\{ needs\.quality\.result \}\}/u);
  assert.match(ci, /TESTS_RESULT: \$\{\{ needs\.tests\.result \}\}/u);
  assert.match(ci, /INTEGRATION_RESULT: \$\{\{ needs\.integration\.result \}\}/u);
  assert.match(ci, /test "\$PROVENANCE_RESULT" = success/u);
  assert.match(ci, /if \[\[ "\$REUSE" == "true" \]\]/u);
  assert.equal(ci.match(/test "\$QUALITY_RESULT" = (?:skipped|success)/gu)?.length, 2);
  assert.equal(ci.match(/test "\$TESTS_RESULT" = (?:skipped|success)/gu)?.length, 2);
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
  assert.match(release, /LOCAL_POSTGRES_ENV="\$ROOT\/\.sutra\/docker\.env"/u);
  assert.match(release, /value\.isFile\(\).+value\.isSymbolicLink\(\).+value\.mode & 0o077/su);
  assert.match(release, /install -m 0600 "\$LOCAL_POSTGRES_ENV" "\$source_root\/\.sutra\/docker\.env"/u);
  assert.match(release, /for shard in 1 2 3 4; do/u);
  assert.match(release, /node scripts\/ci-test-shard\.mjs --shard "\$\{shard\}\/4"/u);
  assert.match(release, /if wait "\$\{shard_pids\[\$shard\]\}"; then/u);
  assert.match(release, /One or more PR-gate shards failed/u);
  assert.doesNotMatch(release, /^node scripts\/ci-test-shard\.mjs$/mu);
  assert.match(release, /pnpm db:postgres:test/u);
  assert.match(release, /rm -f "\$source_root\/\.sutra\/docker\.env"/u);
  assert.ok(
    release.indexOf("pnpm db:postgres:test") < release.indexOf("node scripts/check-repository-secrets.mjs"),
    "the isolated database gate must fail before the long source gate",
  );
  assert.ok(
    release.indexOf('rm -f "$source_root/.sutra/docker.env"') < candidateBuild,
    "the ephemeral database secret must be removed before the Docker build",
  );
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
    new URL("../.github/workflows/ec2-live-release.yml", import.meta.url),
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
  assert.match(workflow, /^\s{2}workflow_run:\s*$/mu);
  assert.match(workflow, /workflows:\s*\n\s+- CI/u);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/u);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/u);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/u);
  assert.match(workflow, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/u);
  assert.doesNotMatch(workflow, /^\s{2}(push|pull_request):\s*$/mu);
  assert.match(workflow, /^\s{4}environment: ec2-live-release\s*$/mu);
  for (const variable of ["AWS_ACCOUNT_ID", "AWS_REGION", "AWS_ROLE_ARN", "EC2_INSTANCE_ID"]) {
    assert.match(workflow, new RegExp(`\\$\\{\\{ vars\\.${variable} \\}\\}`));
  }
  assert.match(workflow, /GITHUB_REF.+refs\/heads\/main/u);
  assert.match(workflow, /ref: \$\{\{ env\.RELEASE_SHA \}\}/u);
  assert.match(workflow, /git rev-parse HEAD.+RELEASE_SHA/u);
  // Publish-before-ship is enforced, not remembered: an automated release must
  // refuse to deploy an application whose pinned onboarding template was never
  // published, because the customer quick-create link would 404.
  const templateGateStart = workflow.indexOf(
    "- name: Require the reviewed onboarding template to be published",
  );
  const oidcStart = workflow.indexOf(
    "- name: Configure short-lived AWS credentials through GitHub OIDC",
  );
  assert.ok(templateGateStart > 0, "the release must gate on the published onboarding template");
  assert.ok(
    templateGateStart < oidcStart,
    "the template gate must fail before credentials are assumed and any image is built",
  );
  const templateGate = workflow.slice(templateGateStart, oidcStart);
  assert.match(templateGate, /vars\.SUTRA_TEMPLATE_BUCKET/u);
  // Where the template is published is independent of where the release
  // deploys. Building the S3 URL from the deployment region silently broke the
  // gate the first time they differed: the template sat in us-east-1 while the
  // release targeted ap-south-1, so the fetch 404'd on a correctly published
  // object.
  assert.match(templateGate, /vars\.SUTRA_TEMPLATE_REGION/u);
  // Both variables are overrides. `vars.*` expands an unset variable to the
  // empty string, so requiring them made an unset variable, a variable created
  // as a secret and a typo'd name all fail identically -- and all of them fail
  // AFTER the operator has published correctly. The default must therefore be
  // the publisher's own default (us-east-1), never the deployment region.
  assert.match(templateGate, /template_region="\$\{TEMPLATE_REGION:-us-east-1\}"/u);
  assert.doesNotMatch(
    templateGate,
    /TEMPLATE_REGION:-\$\{AWS_REGION\}/u,
    "the template region must not default to the deployment region",
  );
  // The bucket is derived the same way scripts/publish-onboarding-template.mjs
  // derives it, so the gate looks where the publisher actually wrote.
  assert.match(
    templateGate,
    /template_bucket="\$\{TEMPLATE_BUCKET:-sutra-onboarding-\$\{AWS_ACCOUNT_ID\}-\$\{template_region\}\}"/u,
  );
  assert.match(templateGate, /\[\[ "\$\{AWS_ACCOUNT_ID\}" =~ \^\[0-9\]\{12\}\$ \]\]/u);
  assert.match(templateGate, /s3\.\$\{template_region\}\.amazonaws\.com/u);
  assert.doesNotMatch(
    templateGate,
    /s3\.\$\{AWS_REGION\}\.amazonaws\.com/u,
    "the template URL must not be built from the deployment region",
  );
  // The deterministic bucket name ends in the region it was created in, so a
  // mismatch is reported as a mismatch rather than an opaque 404.
  assert.match(templateGate, /does not end in the template region/u);
  assert.match(templateGate, /templates\/\$\{version\}\/\$\{digest\}\.yaml/u);
  assert.match(templateGate, /AWS_CUSTOMER_ROLE_TEMPLATE_VERSION/u);
  assert.match(templateGate, /AWS_CUSTOMER_ROLE_TEMPLATE_SHA256/u);
  // Existence alone is not proof: the published bytes must hash to the reviewed
  // digest, and that digest must match the template committed at this revision.
  assert.match(templateGate, /published_digest.+!=.+digest/u);
  assert.match(templateGate, /committed_digest.+==.+digest/u);
  assert.match(templateGate, /public\/sutra-customer-onboarding-role\.yaml/u);
  assert.match(templateGate, /exit 1/u);
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
  assert.match(candidateBuild, /candidate_tag="candidate-\$\{RELEASE_SHA\}-run-/u);
  assert.match(candidateBuild, /release_tag="sha-\$\{RELEASE_SHA\}-run-/u);
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
  // The subject must be the claim GitHub actually mints. This previously read
  // `repo:ydsveluvolu2996@229068958/Sutra@1301833628:ref:refs/heads/main`,
  // which is unmatchable twice over: `sub` carries no numeric ids, and a job
  // declaring `environment:` gets the environment form rather than the ref
  // form. The role was therefore unassumable, and a release died on
  // "Not authorized to perform sts:AssumeRoleWithWebIdentity" the first time
  // the pipeline ever reached the OIDC step.
  const releaseEnvironment = /^\s{4}environment: (\S+)$/mu.exec(workflow);
  assert.ok(releaseEnvironment !== null, "the release job must run in an environment");
  assert.match(
    role,
    new RegExp(
      `token\\.actions\\.githubusercontent\\.com:sub: repo:ydsveluvolu2996/Sutra:environment:${releaseEnvironment[1]}$`,
      "mu",
    ),
    "the trusted subject must name the environment the release job actually runs in",
  );
  assert.doesNotMatch(role, /token\.actions\.githubusercontent\.com:sub:.*\*/u);
  assert.doesNotMatch(
    role,
    /token\.actions\.githubusercontent\.com:sub:.*@[0-9]/u,
    "sub carries no numeric identity; use the repository_id claims for that",
  );
  // The immutable identity the subject cannot express is pinned separately, so
  // an owner rename or a re-registered login still cannot assume this role.
  assert.match(role, /token\.actions\.githubusercontent\.com:repository_owner_id: "229068958"/u);
  assert.match(role, /token\.actions\.githubusercontent\.com:repository_id: "1301833628"/u);
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

test("live EC2 host start and stop remain explicit, SSO-only, and exact-instance bounded", () => {
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
