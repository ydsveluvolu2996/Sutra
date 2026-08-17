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
network="sutra-caddy-contract-$$"
data_volume="sutra-caddy-contract-data-$$"
config_volume="sutra-caddy-contract-config-$$"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
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
grep -Fq 'SUTRA_AWS_STATIC_KEYS_ENABLED: "${SUTRA_AWS_STATIC_KEYS_ENABLED:-false}"' deploy/ec2/compose.prod.yaml || die "Secrets Manager-backed AWS static-key emergency switch is missing."
grep -Fq "Host:'www.\${SUTRA_DOMAIN:?Set SUTRA_DOMAIN in deploy/ec2/.env.ec2}'" deploy/ec2/compose.prod.yaml || die "app healthcheck does not use the canonical public Host."
grep -Fq "'X-Forwarded-Proto':'https'" deploy/ec2/compose.prod.yaml || die "app healthcheck does not preserve public HTTPS provenance."
grep -Fq 'not host origin.{$SUTRA_DOMAIN:sutracmdb.com} www.{$SUTRA_DOMAIN:sutracmdb.com} {$SUTRA_DOMAIN:sutracmdb.com}' deploy/ec2/Caddyfile || die "Caddy's exact tunnel-host allowlist is missing."
grep -Fq 'redir @apex_safe https://www.{$SUTRA_DOMAIN:sutracmdb.com}{uri} 308' deploy/ec2/Caddyfile || die "safe apex canonicalization is missing."
grep -Fq 'not method GET HEAD' deploy/ec2/Caddyfile || die "unsafe apex fail-closed boundary is missing."
grep -Fq 'path /.well-known/security.txt /security.txt' deploy/ec2/Caddyfile || die "Caddy fail-open security.txt paths are missing."
grep -Fq 'rewrite * /security.txt' deploy/ec2/Caddyfile || die "Caddy fail-open security.txt rewrite is missing."
grep -Fq 'Cloudflare-CDN-Cache-Control "public, max-age=86400, stale-while-revalidate=604800"' deploy/ec2/Caddyfile || die "Caddy fail-open security.txt cache contract is missing."
grep -Fq './maintenance:/srv/maintenance:ro' deploy/ec2/compose.prod.yaml || die "Caddy's static assets are not mounted read-only."

tunnel_config=deploy/ec2/cloudflared-config.yml.example
for hostname in origin.sutracmdb.com www.sutracmdb.com sutracmdb.com; do
  count="$(grep -Ec "^[[:space:]]*- hostname: ${hostname//./\\.}$" "$tunnel_config" || true)"
  [[ "$count" == 1 ]] || die "named-tunnel ingress must contain exactly one route for $hostname."
done
if grep -Eq '^[[:space:]]*- hostname: ([*]\.sutracmdb\.com|[*])$' "$tunnel_config"; then
  die "named-tunnel ingress must use exact hostnames, not a wildcard."
fi
origin_line="$(grep -nF -- '- hostname: origin.sutracmdb.com' "$tunnel_config" | cut -d: -f1)"
www_line="$(grep -nF -- '- hostname: www.sutracmdb.com' "$tunnel_config" | cut -d: -f1)"
apex_line="$(grep -nF -- '- hostname: sutracmdb.com' "$tunnel_config" | cut -d: -f1)"
catchall_line="$(grep -nF -- '- service: http_status:404' "$tunnel_config" | cut -d: -f1)"
[[ "$origin_line" -lt "$www_line" && "$www_line" -lt "$apex_line" && "$apex_line" -lt "$catchall_line" ]] || \
  die "named-tunnel exact routes must precede the fail-closed catch-all."
git check-ignore -q --no-index .sutra/cloudflared/config.yml || die "cloudflared config is not gitignored."
git check-ignore -q --no-index .sutra/cloudflared/credentials.json || die "cloudflared credential is not gitignored."
grep -Fq 'chown 65532:65532 "$CLOUDFLARED_CONFIG" "$CLOUDFLARED_CREDENTIAL"' deploy/ec2/bootstrap.sh || die "cloudflared non-root ownership contract is missing."
grep -Fq 'chmod 400 "$CLOUDFLARED_CONFIG" "$CLOUDFLARED_CREDENTIAL"' deploy/ec2/bootstrap.sh || die "cloudflared credential is not host-read-only."

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
docker network create "$network" >/dev/null
docker run -d --rm \
  --name "$container" \
  --network "$network" \
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

raw_tunnel_request() {
  local method="$1" path="$2" host="$3"
  printf '%s %s HTTP/1.1\r\nHost: %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n' \
    "$method" "$path" "$host" |
    docker run --rm -i --network "$network" --entrypoint /bin/sh "$caddy_image" \
      -c 'exec nc "$1" 8080' _ "$container"
}

for host in origin.example.test www.example.test; do
  response="$(raw_tunnel_request GET / "$host" 2>&1 || true)"
  printf '%s\n' "$response" | grep -Eq 'HTTP/1\.[01] 503 Service Unavailable' || \
    die "Caddy did not accept $host and serve maintenance while app was unavailable."
done

response="$(raw_tunnel_request GET '/docs?from=apex' example.test 2>&1 || true)"
printf '%s\n' "$response" | grep -Eq 'HTTP/1\.[01] 308 Permanent Redirect' || \
  die "Caddy did not redirect a safe apex request."
printf '%s\n' "$response" | tr -d '\r' | grep -Fqi 'Location: https://www.example.test/docs?from=apex' || \
  die "Caddy's fail-open apex redirect did not preserve path and query."

response="$(raw_tunnel_request POST /webhooks/falco example.test 2>&1 || true)"
printf '%s\n' "$response" | grep -Eq 'HTTP/1\.[01] 421 Misdirected Request' || \
  die "Caddy redirected or accepted an unsafe apex request."

security_expected="$(cat deploy/ec2/maintenance/security.txt)"
for path in /.well-known/security.txt /security.txt; do
  response="$(raw_tunnel_request GET "$path" www.example.test 2>&1 || true)"
  printf '%s\n' "$response" | grep -Eq 'HTTP/1\.[01] 200 OK' || \
    die "Caddy did not serve $path during Worker fail-open."
  printf '%s\n' "$response" | tr -d '\r' | grep -Fqi 'Content-Type: text/plain; charset=utf-8' || \
    die "Caddy returned the wrong Content-Type for $path."
  printf '%s\n' "$response" | tr -d '\r' | grep -Fqi 'Cloudflare-Cdn-Cache-Control: public, max-age=86400, stale-while-revalidate=604800' || \
    die "Caddy returned the wrong edge cache policy for $path."
  security_body="$(printf '%s' "$response" | sed '1,/^\r$/d')"
  [[ "$security_body" == "$security_expected" ]] || \
    die "Caddy returned non-canonical security.txt bytes at $path."
done

response="$(raw_tunnel_request HEAD /.well-known/security.txt www.example.test 2>&1 || true)"
printf '%s\n' "$response" | grep -Eq 'HTTP/1\.[01] 200 OK' || \
  die "Caddy did not support HEAD for fail-open security.txt."
security_body="$(printf '%s' "$response" | sed '1,/^\r$/d')"
[[ -z "$security_body" ]] || die "Caddy returned a body for HEAD security.txt."

response="$(raw_tunnel_request GET / attacker.example 2>&1 || true)"
printf '%s\n' "$response" | grep -Eq 'HTTP/1\.[01] 421 Misdirected Request' || \
  die "Caddy accepted an unexpected tunnel hostname."

log "All EC2 runtime contracts passed."
