#!/usr/bin/env bash
# Materialize the CloudFormation-owned, non-secret evidence descriptor into the
# protected Compose operator environment. The instance role can read exactly
# this one SSM parameter; customer credentials never enter this path.
set -euo pipefail

log() { printf '[sutra:evidence] %s\n' "$*"; }
die() { printf '[sutra:evidence:error] %s\n' "$*" >&2; exit 1; }

[[ "$#" -le 2 ]] || die "Usage: sync-evidence-runtime.sh [env-file] [docker-env-file]"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${1:-$REPO_ROOT/deploy/ec2/.env.ec2}"
DOCKER_ENV_FILE="${2:-$REPO_ROOT/.sutra/docker.env}"
PARAMETER_NAME="/sutra/private-beta/evidence-config"
EVIDENCE_KEYS=(
  SUTRA_EVIDENCE_BACKEND
  SUTRA_EVIDENCE_BUCKET
  SUTRA_EVIDENCE_KMS_KEY_ARN
  SUTRA_EVIDENCE_RETENTION_DAYS
)

command -v aws >/dev/null 2>&1 || die "AWS CLI is required to read the managed evidence descriptor."
command -v jq >/dev/null 2>&1 || die "jq is required to validate the managed evidence descriptor."
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || die "Evidence target must be an existing regular, non-symlink file."
[[ -f "$DOCKER_ENV_FILE" && ! -L "$DOCKER_ENV_FILE" ]] || die "Docker runtime environment must be an existing regular, non-symlink file."

region_count="$(grep -Ec '^AWS_REGION=' "$ENV_FILE" || true)"
[[ "$region_count" == 0 || "$region_count" == 1 ]] || die "AWS_REGION must appear at most once in the operator environment."
region="$(awk -F= '$1 == "AWS_REGION" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
region="${region:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
[[ "$region" =~ ^[a-z]{2}-[a-z]+-[0-9]+$ ]] || die "An exact AWS Region is required for evidence configuration."

for key in "${EVIDENCE_KEYS[@]}"; do
  count="$(grep -Ec "^${key}=" "$ENV_FILE" || true)"
  [[ "$count" == 0 || "$count" == 1 ]] || die "$key must appear at most once in the operator environment."
  if grep -q "^${key}=" "$DOCKER_ENV_FILE"; then
    die "$key is CloudFormation-owned and must not be overridden in the later Docker runtime environment."
  fi
done

descriptor="$(aws ssm get-parameter \
  --name "$PARAMETER_NAME" \
  --region "$region" \
  --query Parameter.Value \
  --output text \
  --no-cli-pager)" || die "Unable to read the managed evidence descriptor."

jq -e '
  type == "object"
  and keys == ["backend", "bucket", "kmsKeyArn", "retentionDays"]
  and .backend == "s3"
  and (.bucket | type == "string")
  and (.kmsKeyArn | type == "string")
  and (.retentionDays | type == "number" and floor == . and . >= 30 and . <= 3650)
' <<<"$descriptor" >/dev/null || die "The managed evidence descriptor is malformed or incomplete."

backend="$(jq -r '.backend' <<<"$descriptor")"
bucket="$(jq -r '.bucket' <<<"$descriptor")"
kms_key_arn="$(jq -r '.kmsKeyArn' <<<"$descriptor")"
retention_days="$(jq -r '.retentionDays' <<<"$descriptor")"

[[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "The managed evidence bucket name is invalid."
[[ "$bucket" != *..* && ! "$bucket" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "The managed evidence bucket name is invalid."
[[ "$kms_key_arn" =~ ^arn:aws:kms:${region}:[0-9]{12}:key/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || \
  die "The managed evidence KMS key ARN is invalid or belongs to another Region."

temporary="$(mktemp "${ENV_FILE}.evidence.XXXXXX")"
cleanup() { rm -f "$temporary"; }
trap cleanup EXIT INT TERM

awk '!/^SUTRA_EVIDENCE_BACKEND=/ \
  && !/^SUTRA_EVIDENCE_BUCKET=/ \
  && !/^SUTRA_EVIDENCE_KMS_KEY_ARN=/ \
  && !/^SUTRA_EVIDENCE_RETENTION_DAYS=/' \
  "$ENV_FILE" > "$temporary"
printf '%s\n' \
  "SUTRA_EVIDENCE_BACKEND=$backend" \
  "SUTRA_EVIDENCE_BUCKET=$bucket" \
  "SUTRA_EVIDENCE_KMS_KEY_ARN=$kms_key_arn" \
  "SUTRA_EVIDENCE_RETENTION_DAYS=$retention_days" >> "$temporary"
chmod 0600 "$temporary"
mv -f "$temporary" "$ENV_FILE"
trap - EXIT INT TERM

log "Managed evidence runtime configuration synchronized."
