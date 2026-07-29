#!/usr/bin/env bash
# Host-side CVE feed mirror refresh, invoked by sutra-vuln-feeds.service.
#
# Why this exists as a host unit rather than an in-app job: the EPSS feed is
# ~349k rows, and db/postgres-d1-adapter.ts opens one connection per query
# because workerd forbids reusing a socket across requests. A bulk load in the
# request runtime would exhaust the invocation and leave the mirror partially
# written while still reporting a fresh asOf — the worst possible outcome for a
# vulnerability ranking. Here a single long-lived pg connection batches it.
#
# CISA KEV and a bounded NVD window are ALSO refreshed by the in-app
# `vuln-feed-refresh` job every 6h. Running both is harmless: the mirror upserts
# on cve_id, so the later write simply wins.
set -Eeuo pipefail

readonly ROOT="${SUTRA_ROOT:-/opt/sutra}"
log() { printf '[sutra:vuln-feeds] %s\n' "$*"; }
die() { printf '[sutra:vuln-feeds:error] %s\n' "$*" >&2; exit 1; }

# DATABASE_URL arrives via EnvironmentFile so it never reaches the process list.
[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is required (set it in /etc/sutra/vuln-feeds.conf)."
[[ "$DATABASE_URL" == postgres* ]] || die "DATABASE_URL must be a PostgreSQL URL."
[[ -d "$ROOT" ]] || die "$ROOT does not exist."
cd "$ROOT"

readonly APP_CONTAINER="sutra-prod-app-1"
readonly REFRESH_SCRIPT="scripts/vuln-feed-refresh.mjs"

resolve_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  # The app ships as a container; fall back to its bundled Node so the host does
  # not need its own runtime installed.
  if command -v docker >/dev/null 2>&1; then echo "docker"; return; fi
  die "neither node nor docker is available to run the refresh."
}

readonly RUNNER="$(resolve_node)"
log "starting refresh via ${RUNNER}"

# Refuse to run without the reviewed script, rather than silently doing nothing and
# leaving the timer looking healthy.
#
# The check has to happen on the filesystem that will actually execute it. An earlier
# version tested "$ROOT/$REFRESH_SCRIPT" unconditionally, which is the HOST path —
# but /opt/sutra only ever receives deploy/ec2 and docker/, never scripts/. So on
# every host that runs the app as a container (i.e. all of them) the guard failed
# before docker was ever reached, and the real question — is the script inside the
# image? — went unasked. Both filesystems are now checked where each applies.
if [[ "$RUNNER" == "docker" ]]; then
  docker exec "$APP_CONTAINER" test -f "/app/$REFRESH_SCRIPT" 2>/dev/null \
    || die "/app/$REFRESH_SCRIPT is missing from the $APP_CONTAINER image. The release image must ship it and its import closure; see the COPY lines in the root Dockerfile."
  # DATABASE_URL is passed as an env var rather than an argument so it never
  # appears in the container's process list.
  #
  # The two artifact paths are redirected into /app/.sutra, which the image creates
  # owned by the `node` user. Their defaults sit under ./data, and /app is NOT
  # writable by that user — `mkdir /app/data` raised EACCES and killed a run that had
  # already fetched KEV, 10.7 MB of EPSS and the NVD window. The script now writes the
  # database first and treats these as best-effort, so a bad path can no longer lose a
  # refresh; pointing them somewhere writable means they succeed rather than warn.
  docker exec \
    -e DATABASE_URL="$DATABASE_URL" \
    -e VULN_MIRROR_PATH=/app/.sutra/vuln-feeds/mirror.json \
    -e KEV_SNAPSHOT_PATH=/app/.sutra/kev-snapshot.json \
    "$APP_CONTAINER" \
    node "$REFRESH_SCRIPT" \
    || die "refresh failed inside the app container."
else
  [[ -f "$REFRESH_SCRIPT" ]] || die "$REFRESH_SCRIPT is missing from $ROOT."
  DATABASE_URL="$DATABASE_URL" "$RUNNER" "$REFRESH_SCRIPT" \
    || die "refresh failed."
fi

log "refresh completed"
