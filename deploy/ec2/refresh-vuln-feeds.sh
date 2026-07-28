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

# Refuse to run without the reviewed script, rather than silently doing nothing
# and leaving the timer looking healthy.
[[ -f scripts/vuln-feed-refresh.mjs ]] || die "scripts/vuln-feed-refresh.mjs is missing from $ROOT."

resolve_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  # The app ships as a container; fall back to its bundled Node so the host does
  # not need its own runtime installed.
  if command -v docker >/dev/null 2>&1; then echo "docker"; return; fi
  die "neither node nor docker is available to run the refresh."
}

readonly RUNNER="$(resolve_node)"
log "starting refresh via ${RUNNER}"

if [[ "$RUNNER" == "docker" ]]; then
  # --network host so the container reaches the loopback-bound PostgreSQL, and
  # the URL is passed as an env var rather than an argument.
  docker exec -e DATABASE_URL="$DATABASE_URL" sutra-prod-app-1 \
    node scripts/vuln-feed-refresh.mjs \
    || die "refresh failed inside the app container."
else
  DATABASE_URL="$DATABASE_URL" "$RUNNER" scripts/vuln-feed-refresh.mjs \
    || die "refresh failed."
fi

log "refresh completed"
