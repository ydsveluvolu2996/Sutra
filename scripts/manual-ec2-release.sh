#!/usr/bin/env bash
# Quota-independent production release path for Sutra's retained EC2 pilot.
# It intentionally mirrors the GitHub OIDC workflow's source, ECR, scan,
# promotion, SSM and public-verification boundaries while authenticating with
# an interactive operator AWS IAM Identity Center profile.
set -Eeuo pipefail

log() { printf '[sutra:manual-release] %s\n' "$*"; }
die() { printf '[sutra:manual-release:error] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage:
  SUTRA_RELEASE_REASON='10-100 character reason' \
    bash scripts/manual-ec2-release.sh

Prerequisites:
  - a clean, pushed main branch
  - AWS IAM Identity Center login for sutra-administrator
  - Docker/Buildx, Node 22, pnpm 11.13.1, Trivy 0.72.0,
    cfn-lint 1.46.0, AWS CLI v2, jq, curl and OpenSSL
  - the retained Sutra EC2 host manually started and online in SSM

The script has no skip-scan, skip-test, mutable-tag, host-start or arbitrary
SSM-command mode.
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
[[ "$#" -eq 0 ]] || die "No positional arguments are accepted. Use SUTRA_RELEASE_REASON."

readonly PROFILE="${SUTRA_AWS_ADMIN_PROFILE:-sutra-administrator}"
readonly REGION="ap-south-1"
readonly EXPECTED_ACCOUNT="738663485493"
readonly REPOSITORY="sutra/app"
readonly INSTANCE_ID="i-0a7af7b477174a14b"
readonly RELEASE_DOCUMENT="Sutra-DeployImmutableRelease"
readonly PUBLIC_ORIGIN="https://www.sutracmdb.com"
readonly EXPECTED_REMOTE="https://github.com/ydsveluvolu2996/Sutra.git"
readonly RELEASE_REASON="${SUTRA_RELEASE_REASON:-}"

[[ "$PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "The AWS profile name is invalid."
[[ "${#RELEASE_REASON}" -ge 10 && "${#RELEASE_REASON}" -le 100 ]] || \
  die "SUTRA_RELEASE_REASON must contain 10-100 characters."
[[ "$RELEASE_REASON" != *$'\n'* && "$RELEASE_REASON" != *$'\r'* ]] || \
  die "SUTRA_RELEASE_REASON must be one line."
[[ "$RELEASE_REASON" =~ ^[[:print:]]+$ ]] || \
  die "SUTRA_RELEASE_REASON must contain printable characters only."

for credential_name in \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN \
  AWS_WEB_IDENTITY_TOKEN_FILE AWS_CONTAINER_CREDENTIALS_RELATIVE_URI \
  AWS_CONTAINER_CREDENTIALS_FULL_URI; do
  [[ -z "${!credential_name:-}" ]] || \
    die "Static or injected AWS credentials are rejected; use the approved SSO profile."
done

for tool in aws cfn-lint cmp curl docker git jq node openssl pnpm trivy; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required."
done
[[ "$(node --version)" =~ ^v22\. ]] || die "Node.js 22 is required."
[[ "$(pnpm --version)" == "11.13.1" ]] || die "pnpm 11.13.1 is required."
trivy_version="$(trivy --version | awk -F': ' '$1 == "Version" {print $2; exit}')"
[[ "$trivy_version" == "0.72.0" ]] || die "Trivy 0.72.0 is required; found ${trivy_version:-unknown}."
cfn_version="$(cfn-lint --version | awk '{print $NF; exit}')"
[[ "$cfn_version" == "1.46.0" ]] || die "cfn-lint 1.46.0 is required; found ${cfn_version:-unknown}."
aws --version 2>&1 | grep -Eq '^aws-cli/2\.' || die "AWS CLI v2 is required."
docker buildx version >/dev/null 2>&1 || die "Docker Buildx is required."
docker info >/dev/null 2>&1 || die "Docker is not ready."

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "Run this command from the Sutra repository."
cd "$ROOT"
[[ "$(git branch --show-current)" == "main" ]] || die "Releases are allowed only from main."
[[ "$(git remote get-url origin)" == "$EXPECTED_REMOTE" ]] || die "The origin repository does not match Sutra."
[[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]] || \
  die "The worktree must be clean so the image is exactly reproducible from Git."
LOCAL_POSTGRES_ENV="$ROOT/.sutra/docker.env"
node -e '
  const { lstatSync } = require("node:fs");
  const value = lstatSync(process.argv[1]);
  if (!value.isFile() || value.isSymbolicLink() || (value.mode & 0o077) !== 0) process.exit(1);
' "$LOCAL_POSTGRES_ENV" || \
  die "The existing .sutra/docker.env must be a readable, non-symlink regular file with no group/other permissions."

log "Refreshing the immutable main reference."
git fetch --quiet origin main
COMMIT_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse refs/remotes/origin/main)"
[[ "$COMMIT_SHA" =~ ^[a-f0-9]{40}$ ]] || die "The local commit SHA is invalid."
[[ "$COMMIT_SHA" == "$REMOTE_SHA" ]] || \
  die "Local main is not the exact pushed origin/main commit."

aws_cli() {
  aws --profile "$PROFILE" --region "$REGION" --no-cli-pager --no-cli-auto-prompt "$@"
}

run_pr_gate_shards() {
  local shard shard_log failed=0
  local -a shard_pids shard_logs

  # Each shard is a separate Node process and remains serial internally. This
  # preserves the process-global isolation contract while using the duration-
  # balanced partitioning already exercised by CI.
  for shard in 1 2 3 4; do
    shard_log="$work_root/pr-gate-shard-${shard}.log"
    shard_logs[$shard]="$shard_log"
    node scripts/ci-test-shard.mjs --shard "${shard}/4" >"$shard_log" 2>&1 &
    shard_pids[$shard]=$!
  done
  for shard in 1 2 3 4; do
    if wait "${shard_pids[$shard]}"; then
      log "PR-gate shard ${shard}/4 passed."
    else
      failed=1
      log "PR-gate shard ${shard}/4 failed."
    fi
  done
  for shard in 1 2 3 4; do
    printf '\n===== PR-gate shard %s/4 =====\n' "$shard"
    cat "${shard_logs[$shard]}"
  done
  [[ "$failed" -eq 0 ]] || die "One or more PR-gate shards failed."
}

ACCOUNT_ID="$(aws_cli sts get-caller-identity --query Account --output text 2>/dev/null)" || \
  die "AWS SSO is not ready. Run: aws sso login --profile $PROFILE"
[[ "$ACCOUNT_ID" == "$EXPECTED_ACCOUNT" ]] || \
  die "Refusing AWS account $ACCOUNT_ID; expected $EXPECTED_ACCOUNT."
CALLER_ARN="$(aws_cli sts get-caller-identity --query Arn --output text)"
[[ "$CALLER_ARN" == arn:aws:* ]] || die "The AWS caller identity is invalid."

REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
EXPECTED_URI="${REGISTRY}/${REPOSITORY}"
read -r repository_uri tag_mutability scan_on_push encryption_type < <(
  aws_cli ecr describe-repositories \
    --repository-names "$REPOSITORY" \
    --query 'repositories[0].[repositoryUri,imageTagMutability,imageScanningConfiguration.scanOnPush,encryptionConfiguration.encryptionType]' \
    --output text
)
[[ "$repository_uri" == "$EXPECTED_URI" ]] || die "The ECR repository URI is outside the approved boundary."
[[ "$tag_mutability" == "IMMUTABLE" ]] || die "The Sutra ECR repository must be immutable."
[[ "$scan_on_push" == "True" || "$scan_on_push" == "False" ]] || die "The ECR scan configuration is invalid."
[[ "$encryption_type" == "AES256" || "$encryption_type" == "KMS" ]] || die "The ECR repository is not encrypted."

expected_lifecycle="$(jq -cS . deploy/ec2/ecr-lifecycle-policy.json)"
actual_lifecycle_text="$(aws_cli ecr get-lifecycle-policy \
  --repository-name "$REPOSITORY" --query lifecyclePolicyText --output text)"
actual_lifecycle="$(jq -cS . <<< "$actual_lifecycle_text")"
[[ "$actual_lifecycle" == "$expected_lifecycle" ]] || \
  die "The live ECR lifecycle policy drifted from deploy/ec2/ecr-lifecycle-policy.json."

work_root="$(mktemp -d "${TMPDIR:-/tmp}/sutra-manual-release.XXXXXX")"
source_root="$work_root/source"
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  cd "$ROOT" >/dev/null 2>&1 || true
  docker logout "$REGISTRY" >/dev/null 2>&1 || true
  if git worktree list --porcelain 2>/dev/null | grep -Fqx "worktree $source_root"; then
    git worktree remove --force "$source_root" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$work_root"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Gates and the Docker context use a private detached worktree, not mutable
# files in the operator's checkout. The release therefore remains byte-bound
# to the pushed commit even if another tool edits the primary checkout later.
git worktree add --quiet --detach "$source_root" "$COMMIT_SHA"
cd "$source_root"
[[ "$(git rev-parse HEAD)" == "$COMMIT_SHA" ]]
[[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]]
mkdir -m 0700 "$source_root/.sutra"
install -m 0600 "$LOCAL_POSTGRES_ENV" "$source_root/.sutra/docker.env"

log "Running the complete source and deployment gate on the detached release commit."
pnpm install --frozen-lockfile
log "Running the isolated PostgreSQL gate with an ephemeral copy of the retained local database secret."
pnpm db:postgres:test
rm -f "$source_root/.sutra/docker.env"
rmdir "$source_root/.sutra"
node scripts/check-repository-secrets.mjs
pnpm audit --prod --audit-level moderate
pnpm typecheck
pnpm typecheck:collector
pnpm lint
trivy fs --quiet --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 .
trivy config --quiet --severity HIGH,CRITICAL --exit-code 1 --ignorefile .trivyignore.yaml .
node scripts/pipeline-scan.mjs --fail-on high
run_pr_gate_shards
pnpm test:collector
cfn-lint \
  infrastructure/local-collector-role.yaml \
  infrastructure/customer-onboarding-role.yaml \
  infrastructure/hosted-identity.yaml \
  infrastructure/github-ec2-release-role.yaml \
  public/sutra-customer-onboarding-role.yaml
pnpm build
pnpm test:rendered
bash deploy/ec2/validate-ops.sh

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
CANDIDATE_TAG="candidate-${COMMIT_SHA}-manual-${timestamp}"
RELEASE_TAG="sha-${COMMIT_SHA}-manual-${timestamp}"
[[ "$CANDIDATE_TAG" =~ ^candidate-[a-f0-9]{40}-manual-[0-9]{8}T[0-9]{6}Z$ ]]
[[ "$RELEASE_TAG" =~ ^sha-[a-f0-9]{40}-manual-[0-9]{8}T[0-9]{6}Z$ ]]
CANDIDATE_IMAGE="${EXPECTED_URI}:${CANDIDATE_TAG}"

log "Authenticating Docker to the approved account-local ECR repository."
aws_cli ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

log "Building and pushing an immutable candidate with provenance and SBOM attestations."
docker buildx build \
  --file Dockerfile \
  --platform linux/amd64 \
  --provenance=mode=max \
  --sbom=true \
  --push \
  --tag "$CANDIDATE_IMAGE" \
  .

IMAGE_DIGEST="$(aws_cli ecr describe-images \
  --repository-name "$REPOSITORY" \
  --image-ids "imageTag=${CANDIDATE_TAG}" \
  --query 'imageDetails[0].imageDigest' \
  --output text)"
[[ "$IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || die "ECR returned an invalid candidate digest."
IMAGE_REF="${EXPECTED_URI}@${IMAGE_DIGEST}"
[[ "$IMAGE_REF" == "${EXPECTED_URI}@sha256:"* ]] || die "The candidate escaped the approved ECR boundary."

log "Scanning the exact candidate digest; promotion is impossible before this passes."
trivy image --pkg-types os,library --severity HIGH,CRITICAL \
  --ignore-unfixed --exit-code 1 "$IMAGE_REF"

aws_cli ecr batch-get-image \
  --repository-name "$REPOSITORY" \
  --image-ids "imageTag=${CANDIDATE_TAG}" \
  --output json > "$work_root/candidate.json"
jq -e '(.images | length) == 1 and ((.failures // []) | length) == 0' \
  "$work_root/candidate.json" >/dev/null
source_digest="$(jq -r '.images[0].imageId.imageDigest' "$work_root/candidate.json")"
source_tag="$(jq -r '.images[0].imageId.imageTag' "$work_root/candidate.json")"
media_type="$(jq -r '.images[0].imageManifestMediaType' "$work_root/candidate.json")"
manifest="$(jq -r '.images[0].imageManifest' "$work_root/candidate.json")"
[[ "$source_digest" == "$IMAGE_DIGEST" ]]
[[ "$source_tag" == "$CANDIDATE_TAG" ]]
[[ "$media_type" == "application/vnd.oci.image.index.v1+json" ]]
printf '%s' "$manifest" | jq -e '
  .schemaVersion == 2
  and .mediaType == "application/vnd.oci.image.index.v1+json"
  and any(.manifests[];
    .platform.os == "linux" and .platform.architecture == "amd64")
  and any(.manifests[];
    .annotations["vnd.docker.reference.type"] == "attestation-manifest")
' >/dev/null
manifest_digest="sha256:$(printf '%s' "$manifest" | openssl dgst -sha256 -r | awk '{print $1}')"
[[ "$manifest_digest" == "$IMAGE_DIGEST" ]] || die "The OCI manifest hash does not match the scanned digest."

log "Promoting only the scanned OCI manifest to a retained immutable release tag."
promoted_digest="$(aws_cli ecr put-image \
  --repository-name "$REPOSITORY" \
  --image-manifest "$manifest" \
  --image-manifest-media-type "$media_type" \
  --image-tag "$RELEASE_TAG" \
  --image-digest "$IMAGE_DIGEST" \
  --query 'image.imageId.imageDigest' \
  --output text)"
[[ "$promoted_digest" == "$IMAGE_DIGEST" ]] || die "ECR promotion returned a different digest."
retained_digest="$(aws_cli ecr describe-images \
  --repository-name "$REPOSITORY" \
  --image-ids "imageTag=${RELEASE_TAG}" \
  --query 'imageDetails[0].imageDigest' \
  --output text)"
[[ "$retained_digest" == "$IMAGE_DIGEST" ]] || die "The retained release tag does not resolve to the scanned digest."

connection_status="notconnected"
for _ in $(seq 1 6); do
  connection_status="$(aws_cli ssm get-connection-status \
    --target "$INSTANCE_ID" --query Status --output text 2>/dev/null || printf 'notconnected')"
  [[ "$connection_status" == "connected" ]] && break
  sleep 5
done
[[ "$connection_status" == "connected" ]] || \
  die "Start the exact Sutra host manually and wait for it to become connected in SSM."

log "Deploying the exact promoted digest through the constrained SSM document."
parameters="$(jq -cn --arg image_ref "$IMAGE_REF" '{ImageRef:[$image_ref]}')"
command_id="$(aws_cli ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "$RELEASE_DOCUMENT" \
  --comment "$RELEASE_REASON" \
  --timeout-seconds 60 \
  --parameters "$parameters" \
  --query 'Command.CommandId' \
  --output text)"
[[ "$command_id" =~ ^[0-9a-f-]{36}$ ]] || die "SSM returned an invalid command ID."

status="Pending"
for _ in $(seq 1 180); do
  status="$(aws_cli ssm get-command-invocation \
    --command-id "$command_id" \
    --instance-id "$INSTANCE_ID" \
    --query Status --output text 2>/dev/null || printf 'Pending')"
  case "$status" in
    Success) break ;;
    Cancelled|TimedOut|Failed|Cancelling)
      status_details="$(aws_cli ssm get-command-invocation \
        --command-id "$command_id" \
        --instance-id "$INSTANCE_ID" \
        --query StatusDetails --output text 2>/dev/null || printf 'Unavailable')"
      die "SSM release failed: $status_details"
      ;;
    Pending|InProgress|Delayed) sleep 5 ;;
    *) die "Unexpected SSM command status: $status" ;;
  esac
done
[[ "$status" == "Success" ]] || die "SSM release did not complete within 15 minutes."
response_code="$(aws_cli ssm get-command-invocation \
  --command-id "$command_id" \
  --instance-id "$INSTANCE_ID" \
  --query ResponseCode --output text)"
[[ "$response_code" == "0" ]] || die "SSM reported a non-zero release response code."

fetch_200() {
  local path="$1" label="$2" attempts="$3" attempt code
  local headers="$work_root/${label}.headers"
  local body="$work_root/${label}.body"
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    code="$(curl --silent --show-error \
      --connect-timeout 10 --max-time 15 \
      --dump-header "$headers" --output "$body" \
      --write-out '%{http_code}' "${PUBLIC_ORIGIN}${path}")" || code="000"
    [[ "$code" == "200" ]] && return 0
    (( attempt == attempts )) || sleep 5
  done
  die "${PUBLIC_ORIGIN}${path} returned HTTP $code; expected 200."
}

log "Verifying the selected digest and public customer paths."
fetch_200 "/api/healthz" "health" 12
served_image="$(tr -d '\r' < "$work_root/health.headers" | awk '
  tolower($1) == "x-sutra-release-image:" {
    $1 = ""; sub(/^[[:space:]]+/, ""); print
  }
' | tail -n1)"
[[ "$served_image" == "$IMAGE_REF" ]] || \
  die "Public health served ${served_image:-no release identity}; expected $IMAGE_REF."

fetch_200 "/api/turnstile/config" "turnstile-config" 3
jq -e '
  .enabled == true
  and (.siteKey | type == "string" and length >= 10)
  and (keys | sort) == ["enabled", "siteKey"]
' "$work_root/turnstile-config.body" >/dev/null || \
  die "The public Turnstile runtime is disabled, stale, or leaking unexpected fields."

for path in /api/status /login / /about /contact /security /privacy /terms /status /robots.txt /sitemap.xml /.well-known/security.txt /security.txt; do
  label="public-$(tr -cd 'a-z0-9' <<< "$path")"
  [[ "$path" == "/" ]] && label="public-home"
  fetch_200 "$path" "$label" 3
  if [[ "$path" != "/api/status" && "$path" != "/login" && "$path" != *"security.txt" ]] \
    && tr -d '\r' < "$work_root/${label}.headers" | grep -Eiq '^x-robots-tag:.*noindex'; then
    die "${PUBLIC_ORIGIN}${path} is unexpectedly noindex."
  fi
done
grep -Fqx "Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml" "$work_root/public-robotstxt.body"
grep -Fq "<loc>${PUBLIC_ORIGIN}/</loc>" "$work_root/public-sitemapxml.body"
cmp -s \
  "$work_root/public-wellknownsecuritytxt.body" \
  "$work_root/public-securitytxt.body" || \
  die "The two public security.txt paths do not return identical evidence."
grep -Fqx "Contact: ${PUBLIC_ORIGIN}/contact" \
  "$work_root/public-wellknownsecuritytxt.body"
grep -Fqx "Canonical: ${PUBLIC_ORIGIN}/.well-known/security.txt" \
  "$work_root/public-wellknownsecuritytxt.body"

apex_code="$(curl --silent --show-error \
  --connect-timeout 10 --max-time 15 \
  --dump-header "$work_root/apex.headers" --output /dev/null \
  --write-out '%{http_code}' "https://sutracmdb.com/")"
apex_location="$(tr -d '\r' < "$work_root/apex.headers" | awk '
  tolower($1) == "location:" {
    $1 = ""; sub(/^[[:space:]]+/, ""); print
  }
' | tail -n1)"
[[ "$apex_code" == "308" && "$apex_location" == "${PUBLIC_ORIGIN}/" ]] || \
  die "The apex canonical redirect is invalid."

cd "$ROOT"
mkdir -p .sutra/manual-releases
chmod 0700 .sutra/manual-releases
evidence_path=".sutra/manual-releases/${timestamp}-${COMMIT_SHA}.json"
jq -n \
  --arg schema_version "sutra.manual-ec2-release.v1" \
  --arg commit_sha "$COMMIT_SHA" \
  --arg image_ref "$IMAGE_REF" \
  --arg release_tag "$RELEASE_TAG" \
  --arg command_id "$command_id" \
  --arg caller_arn "$CALLER_ARN" \
  --arg reason "$RELEASE_REASON" \
  --arg verified_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    schemaVersion: $schema_version,
    commitSha: $commit_sha,
    imageRef: $image_ref,
    retainedReleaseTag: $release_tag,
    ssmCommandId: $command_id,
    callerArn: $caller_arn,
    reason: $reason,
    publicVerification: "passed",
    verifiedAt: $verified_at
  }' > "$evidence_path"
chmod 0600 "$evidence_path"

log "Release verified."
printf 'Image: %s\nRetained tag: %s\nEvidence: %s\n' \
  "$IMAGE_REF" "$RELEASE_TAG" "$evidence_path"
