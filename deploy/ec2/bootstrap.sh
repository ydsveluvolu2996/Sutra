#!/usr/bin/env bash
# =============================================================================
# Sutra single-box EC2 bootstrap  (Ubuntu 22.04 / 24.04)
# =============================================================================
# Idempotent one-command setup AND redeploy path. Safe to re-run.
#
#   curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/deploy/ec2/bootstrap.sh | bash
#   # or, from a checkout:
#   bash deploy/ec2/bootstrap.sh
#
# It will:
#   1. Install Docker Engine + compose plugin if missing.
#   2. Ensure the repo is present (clone if run standalone via SUTRA_REPO_URL).
#   3. Generate database/job secrets into .sutra/docker.env if absent (0600).
#   4. Ensure deploy/ec2/.env.ec2 exists (copied from the template; prompt on a TTY).
#   5. Build the app image and bring the stack up with `up -d --wait`.
#
# Never echoes secret values. Fails fast with clear messages.
# -----------------------------------------------------------------------------
set -euo pipefail

log()  { printf '\033[36m[sutra]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[sutra:warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[sutra:error]\033[0m %s\n' "$*" >&2; exit 1; }

# --- 0. Configuration ---------------------------------------------------------
SUTRA_REPO_URL="${SUTRA_REPO_URL:-}"
SUTRA_REPO_DIR="${SUTRA_REPO_DIR:-/opt/sutra}"

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

# --- 2. Locate (or clone) the repository -------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [ -f "$SCRIPT_DIR/compose.prod.yaml" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
else
  # Piped execution (curl | bash): we have no checkout — clone one.
  [ -n "$SUTRA_REPO_URL" ] || die "Run standalone requires SUTRA_REPO_URL=<git url> (target dir: $SUTRA_REPO_DIR)."
  if [ ! -d "$SUTRA_REPO_DIR/.git" ]; then
    log "Cloning $SUTRA_REPO_URL -> $SUTRA_REPO_DIR"
    sudo mkdir -p "$SUTRA_REPO_DIR"
    sudo chown "$(id -un)":"$(id -gn)" "$SUTRA_REPO_DIR"
    git clone "$SUTRA_REPO_URL" "$SUTRA_REPO_DIR"
  fi
  REPO_ROOT="$SUTRA_REPO_DIR"
fi
cd "$REPO_ROOT"
log "Repository root: $REPO_ROOT"

COMPOSE_FILE="deploy/ec2/compose.prod.yaml"
ENV_EC2="deploy/ec2/.env.ec2"
ENV_EC2_EXAMPLE="deploy/ec2/.env.ec2.example"
DOCKER_ENV=".sutra/docker.env"
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
      printf 'Enter the Let'\''s Encrypt contact email: '; read -r mail
      [ -n "$dom" ]  && sed -i.bak "s#^SUTRA_DOMAIN=.*#SUTRA_DOMAIN=${dom}#"       "$ENV_EC2"
      [ -n "$mail" ] && sed -i.bak "s#^SUTRA_ACME_EMAIL=.*#SUTRA_ACME_EMAIL=${mail}#" "$ENV_EC2"
      rm -f "$ENV_EC2.bak"
    else
      warn "Non-interactive: edit $ENV_EC2 to set SUTRA_DOMAIN and SUTRA_ACME_EMAIL, then re-run."
    fi
  fi
  # Validate required keys are non-empty (no values are printed).
  # shellcheck disable=SC1090
  local dom mail
  dom="$(grep -E '^SUTRA_DOMAIN=' "$ENV_EC2" | head -n1 | cut -d= -f2-)"
  mail="$(grep -E '^SUTRA_ACME_EMAIL=' "$ENV_EC2" | head -n1 | cut -d= -f2-)"
  [ -n "$dom" ]  || die "SUTRA_DOMAIN is empty in $ENV_EC2."
  [ -n "$mail" ] || die "SUTRA_ACME_EMAIL is empty in $ENV_EC2."
  log "Domain and ACME email are set."
}
ensure_env_ec2

# --- 5. Build + launch --------------------------------------------------------
# Env-file ordering is deliberate: .env.ec2 first (operator settings + harmless
# placeholders), then .sutra/docker.env LAST so the real secrets win over any
# placeholders left in .env.ec2. Only the 3 secret keys are overridden.
ENV_ARGS=(--env-file "$ENV_EC2" --env-file "$DOCKER_ENV")
PROFILE_ARGS=()
if grep -Eq '^SUTRA_NOTIFICATIONS_ENABLED=true' "$ENV_EC2"; then
  log "Notifications enabled -> including the notification-worker profile."
  PROFILE_ARGS=(--profile notifications)
fi

log "Building the app image (this can take a few minutes on first run)..."
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" build

log "Starting the stack and waiting for health..."
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" up -d --wait

log "Stack status:"
$DOCKER compose -f "$COMPOSE_FILE" "${ENV_ARGS[@]}" "${PROFILE_ARGS[@]}" ps
log "Done. Point DNS at this box (see deploy/ec2/README.md) and Caddy will obtain HTTPS automatically."
