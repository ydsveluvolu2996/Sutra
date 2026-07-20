#!/usr/bin/env bash
# =============================================================================
# Sutra redeploy — pull, rebuild, roll the stack forward.
# =============================================================================
# The "future deploys with no hassle" path. Run from a checkout:
#     bash deploy/ec2/redeploy.sh
#
# Pulls latest main, rebuilds the app image, and rolls the running stack with
# `up -d --wait`. Postgres data and Caddy certs persist across this (named
# volumes are untouched). Never prints secrets.
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
[ -f "$ENV_EC2" ]    || die "$ENV_EC2 not found. Run deploy/ec2/bootstrap.sh first."
[ -f "$DOCKER_ENV" ] || die "$DOCKER_ENV not found. Run deploy/ec2/bootstrap.sh first."

DOCKER="docker"
docker info >/dev/null 2>&1 || { sudo docker info >/dev/null 2>&1 && DOCKER="sudo docker"; } || die "Docker daemon unreachable."

ENV_ARGS=(--env-file "$ENV_EC2" --env-file "$DOCKER_ENV")
PROFILE_ARGS=()
if grep -Eq '^SUTRA_NOTIFICATIONS_ENABLED=true' "$ENV_EC2"; then PROFILE_ARGS=(--profile notifications); fi

if [ -d .git ]; then
  log "Pulling latest changes..."
  git pull --ff-only || die "git pull failed (resolve manually, then re-run)."
fi

log "Rebuilding the app image..."
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" build

log "Rolling the stack forward (migrations run automatically)..."
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" up -d --wait

log "Health status:"
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" ps
log "Redeploy complete."
