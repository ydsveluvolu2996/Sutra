#!/usr/bin/env bash
# =============================================================================
# Sutra single-box EC2 bootstrap  (Ubuntu 22.04 / 24.04)
# =============================================================================
# Idempotent one-command setup AND redeploy path. Safe to re-run.
#
#   # Run from the host bundle extracted from an approved immutable app image:
#   bash deploy/ec2/bootstrap.sh
#
# It will:
#   1. Install Docker Engine + compose plugin if missing.
#   2. Require the release bundle extracted from the immutable app image.
#   3. Generate database/job secrets into .sutra/docker.env if absent (0600).
#   4. Ensure deploy/ec2/.env.ec2 exists (copied from the template; prompt on a TTY).
#   5. Validate and permission the ignored Cloudflare tunnel files for the
#      pinned image's non-root UID.
#   6. Pull the immutable app release and bring the stack up with `up -d --wait`.
#
# Never echoes secret values. Fails fast with clear messages.
# -----------------------------------------------------------------------------
set -euo pipefail

log()  { printf '\033[36m[sutra]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[sutra:warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[sutra:error]\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Docker Engine + compose plugin ---------------------------------------
install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker Engine + compose plugin already present."
    return
  fi
  log "Installing Docker Engine + compose plugin (official convenience script)..."
  command -v curl >/dev/null 2>&1 || { sudo apt-get update -y && sudo apt-get install -y curl; }
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sudo sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
  # Let the invoking (non-root) user run docker without sudo on next login.
  if [ -n "${SUDO_USER:-}" ]; then sudo usermod -aG docker "$SUDO_USER" || true
  elif [ "$(id -u)" -ne 0 ]; then sudo usermod -aG docker "$(id -un)" || true; fi
  docker compose version >/dev/null 2>&1 || die "Docker compose plugin still unavailable after install."
  log "Docker installed. You may need to re-login for group membership to take effect."
}
install_docker

# Prefer sudo-less docker; fall back to sudo if the socket is not yet accessible.
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if sudo docker info >/dev/null 2>&1; then DOCKER="sudo docker"; else die "Cannot talk to the Docker daemon."; fi
fi

# --- 2. Locate the immutable release bundle ----------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
[ -f "$SCRIPT_DIR/compose.prod.yaml" ] || die "bootstrap.sh must run from deploy/ec2 in the host bundle extracted from the approved immutable Sutra app image. Git cloning is intentionally unsupported."
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"
log "Immutable release bundle root: $REPO_ROOT"

COMPOSE_FILE="deploy/ec2/compose.prod.yaml"
ENV_EC2="deploy/ec2/.env.ec2"
ENV_EC2_EXAMPLE="deploy/ec2/.env.ec2.example"
DOCKER_ENV=".sutra/docker.env"
CLOUDFLARED_DIR=".sutra/cloudflared"
CLOUDFLARED_CONFIG="$CLOUDFLARED_DIR/config.yml"
CLOUDFLARED_CREDENTIAL="$CLOUDFLARED_DIR/credentials.json"
CLOUDFLARED_CONFIG_EXAMPLE="deploy/ec2/cloudflared-config.yml.example"
[ -f "$COMPOSE_FILE" ] || die "$COMPOSE_FILE not found under $REPO_ROOT."

# --- 3. Generate database/job secrets (idempotent) ----------------------------
# Mirrors scripts/docker-local-env.mjs: two distinct 256-bit base64url passwords
# (43 chars) + one 256-bit hex job token (64 chars). Reuses the existing Node
# generator when Node is on the host; otherwise reproduces the identical format
# with openssl so a Docker-only box still works turnkey.
gen_b64url() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '='; }
gen_hex()    { openssl rand -hex 32; }

ensure_secrets() {
  mkdir -p .sutra && chmod 700 .sutra
  if [ -f "$DOCKER_ENV" ]; then
    log "Reusing existing $DOCKER_ENV (secrets untouched)."
    chmod 600 "$DOCKER_ENV"
    return
  fi
  # Guard: if a prod database volume exists without its secret file, refuse to
  # mint a mismatched one (it would lock the app out of its own database).
  if $DOCKER volume inspect sutra-prod_sutra_postgres_data >/dev/null 2>&1; then
    die "sutra-prod_sutra_postgres_data exists but $DOCKER_ENV is missing. Restore the original secret file; do not generate a replacement unless the database is intentionally discarded."
  fi
  if command -v node >/dev/null 2>&1 && [ -d node_modules ]; then
    log "Generating secrets via scripts/docker-local-env.mjs (Node generator)."
    node -e 'import("./scripts/docker-local-env.mjs").then(m=>m.ensureDockerLocalEnvironment(process.cwd()))' \
      || die "Node secret generator failed."
  else
    log "Generating secrets with openssl (Docker-only host)."
    local owner app token
    owner="$(gen_b64url)"; app="$(gen_b64url)"; token="$(gen_hex)"
    [ "$owner" != "$app" ] || die "Secret collision; re-run."
    umask 177
    printf 'SUTRA_POSTGRES_OWNER_PASSWORD=%s\nSUTRA_POSTGRES_APP_PASSWORD=%s\nSUTRA_JOB_RUNNER_TOKEN=%s\n' \
      "$owner" "$app" "$token" > "$DOCKER_ENV"
  fi
  chmod 600 "$DOCKER_ENV"
  log "Wrote $DOCKER_ENV (mode 0600). Back this up securely and offline."
}
ensure_secrets

# --- 4. Operator env (.env.ec2) ----------------------------------------------
ensure_env_ec2() {
  if [ -f "$ENV_EC2" ]; then
    log "Using existing $ENV_EC2."
  else
    cp "$ENV_EC2_EXAMPLE" "$ENV_EC2"
    chmod 600 "$ENV_EC2"
    warn "Created $ENV_EC2 from template."
    if [ -t 0 ]; then
      printf 'Enter your domain (apex, e.g. sutracmdb.com): '; read -r dom
      [ -n "$dom" ]  && sed -i.bak "s#^SUTRA_DOMAIN=.*#SUTRA_DOMAIN=${dom}#"       "$ENV_EC2"
      rm -f "$ENV_EC2.bak"
    else
      warn "Non-interactive: review $ENV_EC2 and set SUTRA_DOMAIN if needed."
    fi
  fi
  # Hosts created before the static-key backend have no explicit switch. Add
  # the inert value once so later operator enable/disable changes survive every
  # redeploy and immutable bundle replacement in the ignored environment file.
  if ! grep -q '^SUTRA_AWS_STATIC_KEYS_ENABLED=' "$ENV_EC2"; then
    printf '\nSUTRA_AWS_STATIC_KEYS_ENABLED=false\n' >> "$ENV_EC2"
    warn "Added the disabled AWS static-key emergency switch to $ENV_EC2."
  fi
  # Validate required keys are non-empty (no values are printed).
  # shellcheck disable=SC1090
  local dom app_image collector_principal static_keys_enabled static_keys_count
  local turnstile_site_key turnstile_secret_key
  dom="$(grep -E '^SUTRA_DOMAIN=' "$ENV_EC2" | head -n1 | cut -d= -f2-)"
  app_image="$(grep -E '^SUTRA_APP_IMAGE=' "$ENV_EC2" | head -n1 | cut -d= -f2-)"
  collector_principal="$(grep -E '^SUTRA_COLLECTOR_PRINCIPAL_ARN=' "$ENV_EC2" | head -n1 | cut -d= -f2-)"
  static_keys_enabled="$(grep -E '^SUTRA_AWS_STATIC_KEYS_ENABLED=' "$ENV_EC2" | head -n1 | cut -d= -f2-)"
  static_keys_count="$(grep -Ec '^SUTRA_AWS_STATIC_KEYS_ENABLED=' "$ENV_EC2" || true)"
  turnstile_site_key="$(grep -E '^SUTRA_TURNSTILE_SITE_KEY=' "$ENV_EC2" | head -n1 | cut -d= -f2-)"
  turnstile_secret_key="$(grep -E '^SUTRA_TURNSTILE_SECRET_KEY=' "$ENV_EC2" | head -n1 | cut -d= -f2-)"
  [ -n "$dom" ]  || die "SUTRA_DOMAIN is empty in $ENV_EC2."
  [[ "$app_image" =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] || die "SUTRA_APP_IMAGE must be an immutable OCI sha256 digest in $ENV_EC2."
  [[ "$app_image" != 000000000000.* ]] || die "Replace the SUTRA_APP_IMAGE placeholder in $ENV_EC2 before deployment."
  [[ "$collector_principal" =~ ^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$ ]] || die "SUTRA_COLLECTOR_PRINCIPAL_ARN must be the exact canonical IAM role ARN in $ENV_EC2."
  [[ "$collector_principal" != arn:aws:iam::000000000000:* ]] || die "Replace the SUTRA_COLLECTOR_PRINCIPAL_ARN placeholder before deployment."
  [[ "$static_keys_count" == 1 ]] || die "SUTRA_AWS_STATIC_KEYS_ENABLED must appear exactly once in $ENV_EC2."
  [[ "$static_keys_enabled" == true || "$static_keys_enabled" == false ]] || die "SUTRA_AWS_STATIC_KEYS_ENABLED must be exactly true or false in $ENV_EC2."
  if grep -q '^SUTRA_AWS_STATIC_KEYS_ENABLED=' "$DOCKER_ENV"; then
    die "Keep SUTRA_AWS_STATIC_KEYS_ENABLED only in $ENV_EC2; the later runtime env must not override the emergency switch."
  fi
  export SUTRA_AWS_STATIC_KEYS_ENABLED="$static_keys_enabled"
  [[ "$turnstile_site_key" =~ ^[A-Za-z0-9_-]{20,128}$ ]] || die "SUTRA_TURNSTILE_SITE_KEY is missing or invalid in $ENV_EC2."
  [[ "$turnstile_secret_key" =~ ^[A-Za-z0-9_-]{20,128}$ ]] || die "SUTRA_TURNSTILE_SECRET_KEY is missing or invalid in $ENV_EC2."
  [[ "$turnstile_site_key" != REPLACE_* && "$turnstile_secret_key" != REPLACE_* ]] || die "Replace both Cloudflare Turnstile placeholders in $ENV_EC2 before deployment."
  [[ "$turnstile_site_key" != "$turnstile_secret_key" ]] || die "Turnstile site and secret keys must be distinct."
  case "$turnstile_site_key" in
    1x00000000000000000000AA|2x00000000000000000000AB|1x00000000000000000000BB|2x00000000000000000000BB|3x00000000000000000000FF)
      die "Cloudflare Turnstile test site keys are forbidden on the public EC2 deployment."
      ;;
  esac
  case "$turnstile_secret_key" in
    1x0000000000000000000000000000000AA|2x0000000000000000000000000000000AA|3x0000000000000000000000000000000AA)
      die "Cloudflare Turnstile test secret keys are forbidden on the public EC2 deployment."
      ;;
  esac
  log "Canonical domain, immutable application image, collector role and Turnstile keys are set."
}
ensure_env_ec2

# Snapshot publication is fail-closed: obtain the exact non-secret bucket/key
# descriptor with the instance role before Compose renders or the Worker starts.
bash "$SCRIPT_DIR/sync-evidence-runtime.sh" \
  "$REPO_ROOT/$ENV_EC2" "$REPO_ROOT/$DOCKER_ENV"

# --- 5. Cloudflare named-tunnel files -----------------------------------------
ensure_cloudflared() {
  mkdir -p "$CLOUDFLARED_DIR"
  chmod 700 "$CLOUDFLARED_DIR"
  if [ ! -f "$CLOUDFLARED_CONFIG" ]; then
    cp "$CLOUDFLARED_CONFIG_EXAMPLE" "$CLOUDFLARED_CONFIG"
    warn "Created $CLOUDFLARED_CONFIG from the committed tunnel template."
  fi
  [ -f "$CLOUDFLARED_CREDENTIAL" ] || die "Missing $CLOUDFLARED_CREDENTIAL. Install the credential JSON for the named Sutra tunnel; never commit or paste it into logs."
  # cloudflare/cloudflared runs as numeric UID/GID 65532. Bind-mounted files
  # remain root-managed on the host but must be readable by that exact UID.
  # Mode 0400 prevents every other host/container identity from reading them.
  sudo chown 65532:65532 "$CLOUDFLARED_CONFIG" "$CLOUDFLARED_CREDENTIAL"
  sudo chmod 400 "$CLOUDFLARED_CONFIG" "$CLOUDFLARED_CREDENTIAL"
  log "Ignored Cloudflare named-tunnel files are present with non-root read-only ownership."
}
ensure_cloudflared

# --- 6. Pull + launch ---------------------------------------------------------
# Env-file ordering is deliberate: .env.ec2 first (operator settings + harmless
# placeholders), then .sutra/docker.env LAST so the real secrets win over any
# placeholders left in .env.ec2. Only the 3 secret keys are overridden.
ENV_ARGS=(--env-file "$ENV_EC2" --env-file "$DOCKER_ENV")
PROFILE_ARGS=()
if grep -Eq '^SUTRA_NOTIFICATIONS_ENABLED=true' "$ENV_EC2"; then
  log "Notifications enabled -> including the notification-worker profile."
  PROFILE_ARGS=(--profile notifications)
fi

authenticate_registry() {
  local app_image registry region
  app_image="$(grep -E '^SUTRA_APP_IMAGE=' "$ENV_EC2" | head -n1 | cut -d= -f2-)"
  registry="${app_image%%/*}"
  if [[ "$registry" =~ ^[0-9]{12}\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$ ]]; then
    command -v aws >/dev/null 2>&1 || die "AWS CLI is required to authenticate to the private ECR release registry."
    region="${BASH_REMATCH[1]}"
    log "Authenticating Docker to the scoped ECR registry."
    aws ecr get-login-password --region "$region" | $DOCKER login --username AWS --password-stdin "$registry" >/dev/null
  fi
}
authenticate_registry

log "Pulling immutable application and infrastructure images..."
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" pull postgres migrate app caddy cloudflared

log "Starting the stack and waiting for health..."
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" up -d --wait --no-build

log "Stack status:"
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" ps
sudo apt-get clean >/dev/null 2>&1 || true
sudo rm -rf /var/lib/apt/lists/* >/dev/null 2>&1 || true
log "Done. Cloudflare Tunnel is the only ingress; no EC2 host port is published."
