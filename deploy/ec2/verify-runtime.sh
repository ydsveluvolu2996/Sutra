#!/usr/bin/env bash
# Deployment-only contract checks for the single-EC2 runtime.
#
# This intentionally uses the committed example environment, never real
# deployment secrets. It validates both Compose profiles, Caddy syntax, the
# network/public-port boundary, named-tunnel ingress rules, Caddy maintenance
# behavior, and the container-local liveness endpoint.
set -euo pipefail

log() { printf '[sutra:ec2-verify] %s\n' "$*"; }
die() { printf '[sutra:ec2-verify:error] %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

command -v docker >/dev/null 2>&1 || die "Docker is required."
docker info >/dev/null 2>&1 || die "Docker daemon is unreachable."
docker compose version >/dev/null 2>&1 || die "Docker Compose is required."

COMPOSE=(docker compose -f deploy/ec2/compose.prod.yaml --env-file deploy/ec2/.env.ec2.example)
rendered="$(mktemp)"
container="sutra-caddy-contract-$$"
data_volume="sutra-caddy-contract-data-$$"
config_volume="sutra-caddy-contract-config-$$"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$data_volume" "$config_volume" >/dev/null 2>&1 || true
  rm -f "$rendered"
}
trap cleanup EXIT

log "Validating Compose (base and notifications profile)..."
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" --profile notifications config --quiet
"${COMPOSE[@]}" config > "$rendered"

service_block() {
  local service="$1"
  awk -v wanted="$service" '
    $0 == "  " wanted ":" { inside=1; print; next }
    inside && /^  [A-Za-z0-9_-]+:$/ { exit }
    inside { print }
  ' "$rendered"
}

# Cloudflare Tunnel is the sole ingress. `expose` is internal metadata and is
# fine, but no Compose service may publish any EC2 host port.
for service in app postgres migrate caddy cloudflared; do
  if service_block "$service" | grep -Eq '^    ports:'; then
    die "$service unexpectedly publishes a host port."
  fi
done

# Postgres must stay on the internal data bridge; Caddy and cloudflared must
# remain segmented from it.
grep -Eq '^  data:$' "$rendered" || die "data network is missing."
grep -Eq '^    internal: true$' "$rendered" || die "data network lost its internal boundary."
service_block postgres | grep -Eq '^      data:' || die "Postgres is not on the data network."
if service_block caddy | grep -Eq '^      data:'; then
  die "Caddy must not share the Postgres data network."
fi
service_block cloudflared | grep -Eq '^      tunnel:' || die "cloudflared is not on the tunnel network."
if service_block cloudflared | grep -Eq '^      (application|data|app-egress|worker-egress):'; then
  die "cloudflared crossed an internal application/data network boundary."
fi

# Preserve the tunnel-only trust contract: the origin is unexposed, Caddy uses
# Cloudflare's canonical client header, and the private HTTP hop never weakens
# Secure-cookie detection in the application.
grep -Eq '^[[:space:]]*auto_https off$' deploy/ec2/Caddyfile || die "private-origin auto-HTTPS boundary is missing."
grep -Fq 'header_up X-Forwarded-For {http.request.header.CF-Connecting-IP}' deploy/ec2/Caddyfile || die "canonical Cloudflare client IP is missing."
grep -Eq '^[[:space:]]*header_up X-Forwarded-Proto https$' deploy/ec2/Caddyfile || die "public HTTPS provenance is missing."
grep -Fq 'header_up Host www.{$SUTRA_DOMAIN:sutracmdb.com}' deploy/ec2/Caddyfile || die "canonical public Host is missing."
if grep -Eq '^[[:space:]]*header_up Host (127\.0\.0\.1|localhost)' deploy/ec2/Caddyfile; then
  die "Caddy must not disguise a public request as loopback."
fi
grep -Eq '^[[:space:]]*header_up -CF-Access-Client-Secret$' deploy/ec2/Caddyfile || die "untrusted Cloudflare identity-header stripping is missing."
grep -Eq '^[[:space:]]*SUTRA_DEPLOYMENT_ENV: staging$' deploy/ec2/compose.prod.yaml || die "private-beta staging boundary is missing."
grep -Eq '^[[:space:]]*SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "true"$' deploy/ec2/compose.prod.yaml || die "private-beta password gate is missing."
grep -Eq '^[[:space:]]*SUTRA_PASSWORD_MFA_REQUIRED: "true"$' deploy/ec2/compose.prod.yaml || die "mandatory MFA flag is missing."
grep -Eq '^[[:space:]]*SUTRA_COLLECTOR_MODE: live$' deploy/ec2/compose.prod.yaml || die "live collector mode is missing."
grep -Eq '^[[:space:]]*SUTRA_ALLOW_LIVE_AWS: "true"$' deploy/ec2/compose.prod.yaml || die "live AWS consent flag is missing."
grep -Fq "Host:'www.\${SUTRA_DOMAIN:?Set SUTRA_DOMAIN in deploy/ec2/.env.ec2}'" deploy/ec2/compose.prod.yaml || die "app healthcheck does not use the canonical public Host."
grep -Fq "'X-Forwarded-Proto':'https'" deploy/ec2/compose.prod.yaml || die "app healthcheck does not preserve public HTTPS provenance."
grep -Eq '^[[:space:]]*- hostname: origin\.sutracmdb\.com$' deploy/ec2/cloudflared-config.yml.example || die "protected origin tunnel route is missing."
if grep -Eq '^[[:space:]]*- hostname: (www\.)?sutracmdb\.com$' deploy/ec2/cloudflared-config.yml.example; then
  die "public hostnames must not bypass the Worker through the tunnel."
fi
git check-ignore -q --no-index .sutra/cloudflared/config.yml || die "cloudflared config is not gitignored."
git check-ignore -q --no-index .sutra/cloudflared/credentials.json || die "cloudflared credential is not gitignored."

# systemctl stop must preserve Caddy + tunnel so application maintenance still
# produces an edge-visible 503 rather than tearing down the ingress connector.
grep -Eq '^ExecStop=.* compose .* stop app$' deploy/ec2/sutra.service || die "systemd app-only maintenance stop contract changed."
if grep -Eq '^ExecStop=.* (down|stop (caddy|cloudflared))' deploy/ec2/sutra.service; then
  die "systemd stop tears down the maintenance path."
fi

caddy_image="$(service_block caddy | awk '$1 == "image:" { print $2; exit }')"
[ -n "$caddy_image" ] || die "Unable to resolve the pinned Caddy image."
case "$caddy_image" in
  *@sha256:*) ;;
  *) die "Caddy image is not digest-pinned." ;;
esac

cloudflared_image="$(service_block cloudflared | awk '$1 == "image:" { print $2; exit }')"
[ -n "$cloudflared_image" ] || die "Unable to resolve the pinned cloudflared image."
case "$cloudflared_image" in
  *@sha256:*) ;;
  *) die "cloudflared image is not digest-pinned." ;;
esac

log "Validating named-tunnel ingress configuration..."
docker run --rm --network none \
  -v "$REPO_ROOT/deploy/ec2/cloudflared-config.yml.example:/etc/cloudflared/config.yml:ro" \
  "$cloudflared_image" tunnel --config /etc/cloudflared/config.yml ingress validate

log "Validating Caddy configuration..."
docker run --rm --network none \
  --entrypoint caddy \
  -e SUTRA_DOMAIN=sutracmdb.com \
  -v "$REPO_ROOT/deploy/ec2/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "$caddy_image" validate --config /etc/caddy/Caddyfile --adapter caddyfile

log "Exercising Caddy's container-liveness endpoint..."
docker run -d --rm \
  --name "$container" \
  --network none \
  --read-only \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --cap-add NET_BIND_SERVICE \
  --tmpfs /tmp:size=16m,mode=1777 \
  -e SUTRA_DOMAIN=example.test \
  -v "$REPO_ROOT/deploy/ec2/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$REPO_ROOT/deploy/ec2/maintenance:/srv/maintenance:ro" \
  -v "$data_volume:/data" \
  -v "$config_volume:/config" \
  "$caddy_image" >/dev/null

healthy=false
for _ in 1 2 3 4 5; do
  if docker exec "$container" wget --spider -q http://127.0.0.1:8080/caddy-healthz; then
    healthy=true
    break
  fi
  sleep 1
done
[ "$healthy" = true ] || die "Caddy liveness endpoint did not become healthy."

maintenance=false
for _ in 1 2 3 4 5; do
  response="$(docker exec "$container" wget --spider -S http://127.0.0.1:8080/ 2>&1 || true)"
  if printf '%s\n' "$response" | grep -Eq 'HTTP/1\.[01] 503 Service Unavailable'; then
    maintenance=true
    break
  fi
  sleep 1
done
[ "$maintenance" = true ] || die "Caddy did not serve HTTP 503 while app was unavailable."

log "All EC2 runtime contracts passed."
