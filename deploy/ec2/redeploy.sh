#!/usr/bin/env bash
# =============================================================================
# Sutra redeploy — reapply the already-selected immutable release.
# =============================================================================
# The "future deploys with no hassle" path. Run from the extracted host bundle:
#     bash deploy/ec2/redeploy.sh
#
# Pulls the immutable app digest configured in `.env.ec2`, then rolls the
# running stack with `up -d --wait --no-build`. It never reads GitHub, compiles
# source, or changes the selected digest. Use release-update.sh via SSM to select
# a different approved digest. Named data volumes are untouched. Never prints secrets.
# -----------------------------------------------------------------------------
set -euo pipefail

log()  { printf '\033[36m[sutra]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[sutra:error]\033[0m %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="deploy/ec2/compose.prod.yaml"
ENV_EC2="deploy/ec2/.env.ec2"
DOCKER_ENV=".sutra/docker.env"
CLOUDFLARED_CONFIG=".sutra/cloudflared/config.yml"
CLOUDFLARED_CREDENTIAL=".sutra/cloudflared/credentials.json"
[ -f "$ENV_EC2" ]    || die "$ENV_EC2 not found. Run deploy/ec2/bootstrap.sh first."
[ -f "$DOCKER_ENV" ] || die "$DOCKER_ENV not found. Run deploy/ec2/bootstrap.sh first."
[ -f "$CLOUDFLARED_CONFIG" ] || die "$CLOUDFLARED_CONFIG not found. Run deploy/ec2/bootstrap.sh first."
[ -f "$CLOUDFLARED_CREDENTIAL" ] || die "$CLOUDFLARED_CREDENTIAL not found. Restore the named-tunnel credential; never generate an unrelated replacement."

DOCKER="docker"
docker info >/dev/null 2>&1 || { sudo docker info >/dev/null 2>&1 && DOCKER="sudo docker"; } || die "Docker daemon unreachable."

ENV_ARGS=(--env-file "$ENV_EC2" --env-file "$DOCKER_ENV")
PROFILE_ARGS=()
if grep -Eq '^SUTRA_NOTIFICATIONS_ENABLED=true' "$ENV_EC2"; then PROFILE_ARGS=(--profile notifications); fi

app_image="$(grep -E '^SUTRA_APP_IMAGE=' "$ENV_EC2" | head -n1 | cut -d= -f2-)"
[[ "$app_image" =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] || die "SUTRA_APP_IMAGE must be an immutable OCI sha256 digest."
registry="${app_image%%/*}"
if [[ "$registry" =~ ^[0-9]{12}\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$ ]]; then
  command -v aws >/dev/null 2>&1 || die "AWS CLI is required to authenticate to ECR."
  aws ecr get-login-password --region "${BASH_REMATCH[1]}" | $DOCKER login --username AWS --password-stdin "$registry" >/dev/null
fi

log "Pulling the configured immutable release..."
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" pull postgres migrate app caddy cloudflared

log "Rolling the stack forward (migrations run automatically)..."
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" up -d --wait --no-build

log "Health status:"
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" ps
log "Redeploy complete."
