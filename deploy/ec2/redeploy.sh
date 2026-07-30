#!/usr/bin/env bash
# =============================================================================
# Sutra redeploy — reapply the already-selected immutable release.
# =============================================================================
# The "future deploys with no hassle" path. Run from the extracted host bundle:
#     bash deploy/ec2/redeploy.sh
#
# Pulls the immutable app digest configured in `.env.ec2`, then rolls the
# running stack with `up -d --wait --no-build`. Version-controlled edge
# configuration is validated and explicitly reloaded so a bundle-only change
# cannot leave Caddy or cloudflared on their previous process configuration. It
# never reads GitHub, compiles source, or changes the selected digest. Use
# release-update.sh via SSM to select a different approved digest. Named data
# volumes are untouched. Never prints secrets.
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
CLOUDFLARED_CONFIG_TEMPLATE="deploy/ec2/cloudflared-config.yml.example"
[ -f "$ENV_EC2" ]    || die "$ENV_EC2 not found. Run deploy/ec2/bootstrap.sh first."
[ -f "$DOCKER_ENV" ] || die "$DOCKER_ENV not found. Run deploy/ec2/bootstrap.sh first."
[ -f "$CLOUDFLARED_CONFIG" ] || die "$CLOUDFLARED_CONFIG not found. Run deploy/ec2/bootstrap.sh first."
[ -f "$CLOUDFLARED_CREDENTIAL" ] || die "$CLOUDFLARED_CREDENTIAL not found. Restore the named-tunnel credential; never generate an unrelated replacement."
[ -f "$CLOUDFLARED_CONFIG_TEMPLATE" ] || die "$CLOUDFLARED_CONFIG_TEMPLATE is missing from the selected release bundle."

if [[ -x "$SCRIPT_DIR/sync-zoho-runtime.sh" ]]; then
  if (( EUID == 0 )); then
    "$SCRIPT_DIR/sync-zoho-runtime.sh" --optional
  else
    command -v sudo >/dev/null 2>&1 || die "Root privileges are required to install the protected Zoho runtime."
    sudo "$SCRIPT_DIR/sync-zoho-runtime.sh" --optional
  fi
fi

DOCKER="docker"
docker info >/dev/null 2>&1 || { sudo docker info >/dev/null 2>&1 && DOCKER="sudo docker"; } || die "Docker daemon unreachable."
ROOT_RUN=()
if (( EUID != 0 )); then
  command -v sudo >/dev/null 2>&1 || die "Root privileges are required to update the protected tunnel configuration."
  ROOT_RUN=(sudo)
fi

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

cloudflared_image="$(awk '
  $0 == "  cloudflared:" { in_service = 1; next }
  in_service && /^  [A-Za-z0-9_-]+:$/ { exit }
  in_service && $1 == "image:" { print $2; exit }
' "$COMPOSE_FILE")"
[[ "$cloudflared_image" =~ ^cloudflare/cloudflared:[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || \
  die "The cloudflared image must remain pinned to an immutable OCI sha256 digest."

log "Validating the selected release's named-tunnel routing..."
$DOCKER run --rm --network none \
  -v "$REPO_ROOT/$CLOUDFLARED_CONFIG_TEMPLATE:/etc/cloudflared/release-config.yml:ro" \
  "$cloudflared_image" tunnel --config /etc/cloudflared/release-config.yml ingress validate

# The active tunnel config is intentionally outside Git and protected from the
# app user. Keep it byte-identical to the selected release template without
# touching the named-tunnel credential. A same-directory rename makes the
# replacement atomic; cloudflared is recreated below so it binds the new inode.
if ! "${ROOT_RUN[@]}" cmp -s "$CLOUDFLARED_CONFIG_TEMPLATE" "$CLOUDFLARED_CONFIG"; then
  staged_cloudflared_config="${CLOUDFLARED_CONFIG}.release.$$"
  "${ROOT_RUN[@]}" rm -f "$staged_cloudflared_config"
  "${ROOT_RUN[@]}" install -o 65532 -g 65532 -m 0400 \
    "$CLOUDFLARED_CONFIG_TEMPLATE" "$staged_cloudflared_config"
  if ! "${ROOT_RUN[@]}" mv -f "$staged_cloudflared_config" "$CLOUDFLARED_CONFIG"; then
    "${ROOT_RUN[@]}" rm -f "$staged_cloudflared_config"
    die "Unable to atomically activate the selected release's tunnel configuration."
  fi
  log "Activated the selected release's named-tunnel routing."
fi
"${ROOT_RUN[@]}" chown 65532:65532 "$CLOUDFLARED_CONFIG"
"${ROOT_RUN[@]}" chmod 0400 "$CLOUDFLARED_CONFIG"
"${ROOT_RUN[@]}" cmp -s "$CLOUDFLARED_CONFIG_TEMPLATE" "$CLOUDFLARED_CONFIG" || \
  die "The active named-tunnel routing differs from the selected release."

log "Rolling the stack forward (migrations run automatically)..."
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" up -d --wait --no-build

# Compose compares mount paths, not the bytes behind those paths. Explicitly
# recreate the two edge processes after every selected-bundle application so
# Caddy reloads its Caddyfile/maintenance assets and cloudflared reopens the
# atomically replaced config. Recreate Caddy first to preserve the dependency
# ordering and keep the tunnel fail-closed during the short refresh.
log "Reloading the selected release's Caddy configuration and static assets..."
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" \
  up -d --wait --no-build --no-deps --force-recreate caddy
log "Reloading the selected release's named-tunnel routing..."
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" \
  up -d --wait --no-build --no-deps --force-recreate cloudflared

log "Health status:"
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" ps
log "Redeploy complete."
