#!/usr/bin/env bash
# Encrypted, coordinated backup for the single-EC2 Sutra deployment.
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

log() { printf '[sutra-backup] %s\n' "$*"; }
die() { printf '[sutra-backup:error] %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "Required command is missing: $1"; }

CONFIG_FILE="${SUTRA_BACKUP_CONFIG:-/etc/sutra/backup.conf}"
if [[ -f "$CONFIG_FILE" ]]; then
  config_uid="$(stat -c '%u' "$CONFIG_FILE")"
  config_mode="$(stat -c '%a' "$CONFIG_FILE")"
  [[ "$config_uid" == 0 ]] || die "$CONFIG_FILE must be owned by root"
  (( (8#$config_mode & 8#022) == 0 )) || die "$CONFIG_FILE must not be group/world writable"
  # shellcheck disable=SC1090
  set -a; source "$CONFIG_FILE"; set +a
fi

BACKUP_ROOT="${SUTRA_BACKUP_ROOT:-/var/backups/sutra}"
REPO_ROOT="${SUTRA_REPO_ROOT:-/opt/sutra}"
COMPOSE_PROJECT="${SUTRA_COMPOSE_PROJECT:-sutra-prod}"
AGE_RECIPIENT="${SUTRA_BACKUP_AGE_RECIPIENT:-}"
S3_URI="${SUTRA_BACKUP_S3_URI:-}"
REQUIRE_OFFSITE="${SUTRA_BACKUP_REQUIRE_OFFSITE:-true}"
RETENTION_DAYS="${SUTRA_BACKUP_LOCAL_RETENTION_DAYS:-14}"
MIN_LOCAL_COPIES="${SUTRA_BACKUP_MIN_LOCAL_COPIES:-3}"
MIN_FREE_MIB="${SUTRA_BACKUP_MIN_FREE_MIB:-2048}"
HELPER_IMAGE="${SUTRA_BACKUP_HELPER_IMAGE:-postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15}"

for command in age aws docker flock openssl python3 realpath sha256sum stat tar; do require "$command"; done
[[ "$REQUIRE_OFFSITE" == true || "$REQUIRE_OFFSITE" == false ]] || die "SUTRA_BACKUP_REQUIRE_OFFSITE must be true or false"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && (( RETENTION_DAYS >= 2 && RETENTION_DAYS <= 3650 )) || die "Local retention must be 2..3650 days"
[[ "$MIN_LOCAL_COPIES" =~ ^[0-9]+$ ]] && (( MIN_LOCAL_COPIES >= 1 && MIN_LOCAL_COPIES <= 100 )) || die "Minimum local copies must be 1..100"
[[ "$MIN_FREE_MIB" =~ ^[0-9]+$ ]] && (( MIN_FREE_MIB >= 512 )) || die "Minimum free space must be at least 512 MiB"
[[ -n "$AGE_RECIPIENT" ]] || die "SUTRA_BACKUP_AGE_RECIPIENT is required; keep its private identity off this host"
[[ "$AGE_RECIPIENT" != *$'\n'* && "$AGE_RECIPIENT" != *$'\r'* ]] || die "Invalid age recipient"
if [[ "$REQUIRE_OFFSITE" == true ]]; then [[ "$S3_URI" == s3://* ]] || die "A valid SUTRA_BACKUP_S3_URI is required"; fi
if [[ -n "$S3_URI" ]]; then
  [[ "$S3_URI" =~ ^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](/[A-Za-z0-9._/-]+)?/?$ ]] || die "SUTRA_BACKUP_S3_URI is unsafe or invalid"
fi

[[ -d "$REPO_ROOT/.git" ]] || die "Repository not found at $REPO_ROOT"
COMPOSE_FILE="$REPO_ROOT/deploy/ec2/compose.prod.yaml"
ENV_EC2="$REPO_ROOT/deploy/ec2/.env.ec2"
DOCKER_ENV="$REPO_ROOT/.sutra/docker.env"
[[ -f "$COMPOSE_FILE" && -f "$ENV_EC2" && -f "$DOCKER_ENV" ]] || die "Compose or environment files are missing"
[[ ! -L "$BACKUP_ROOT" ]] || die "Backup root must not be a symlink"
BACKUP_ROOT="$(realpath -m "$BACKUP_ROOT")"
[[ "$BACKUP_ROOT" == /var/backups/sutra || "$BACKUP_ROOT" == /var/backups/sutra/* ]] || die "Backup root must be /var/backups/sutra or one of its children"
install -d -m 0700 "$BACKUP_ROOT"
MARKER="$BACKUP_ROOT/.sutra-backup-root"
if [[ -e "$MARKER" ]]; then
  [[ -f "$MARKER" && ! -L "$MARKER" && "$(cat "$MARKER")" == sutra-production-backups-v1 ]] || die "Backup root marker is invalid"
else
  printf 'sutra-production-backups-v1\n' > "$MARKER"
  chmod 0600 "$MARKER"
fi
[[ "$(stat -c '%u' "$BACKUP_ROOT")" == 0 ]] || die "Backup root must be owned by root"

exec 8>/run/lock/sutra-data-mutation.lock
flock -n 8 || die "Another release, backup, or restore is already running"
exec 9>"$BACKUP_ROOT/.backup.lock"
flock -n 9 || die "Another backup or restore is already running"
free_mib="$(df -Pm "$BACKUP_ROOT" | awk 'NR==2 {print $4}')"
(( free_mib >= MIN_FREE_MIB )) || die "Only ${free_mib} MiB free; ${MIN_FREE_MIB} MiB required"

cd "$REPO_ROOT"
COMPOSE=(docker compose --project-name "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_EC2" --env-file "$DOCKER_ENV")
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" up -d --wait postgres

is_running() { "${COMPOSE[@]}" ps --services --filter status=running | grep -Fxq "$1"; }
app_was_running=false
worker_was_running=false
is_running app && app_was_running=true
is_running notification-worker && worker_was_running=true

stamp="$(date -u +'%Y%m%dT%H%M%SZ')"
backup_id="sutra-$stamp-$(openssl rand -hex 4)"
stage="$(mktemp -d "$BACKUP_ROOT/.${backup_id}.stage.XXXXXX")"
plaintext="$BACKUP_ROOT/.${backup_id}.tar"
artifact="$BACKUP_ROOT/${backup_id}.tar.age"
checksum="$artifact.sha256"
services_recovered=false
artifact_complete=false

recover_services() {
  local rc=$?
  rm -rf -- "$stage" "$plaintext"
  if [[ "$services_recovered" != true ]]; then
    if [[ "$app_was_running" == true ]]; then "${COMPOSE[@]}" up -d --wait app >/dev/null || true; fi
    if [[ "$worker_was_running" == true ]]; then "${COMPOSE[@]}" start notification-worker >/dev/null || true; fi
  fi
  # Preserve a complete encrypted artifact when only the offsite upload fails;
  # an operator can retry it without repeating the quiesced backup.
  if (( rc != 0 )) && [[ "$artifact_complete" != true ]]; then rm -f -- "$artifact" "$checksum"; fi
  exit "$rc"
}
trap recover_services EXIT INT TERM

if [[ "$worker_was_running" == true ]]; then "${COMPOSE[@]}" stop -t 30 notification-worker; fi
if [[ "$app_was_running" == true ]]; then "${COMPOSE[@]}" stop -t 30 app; fi

log "Creating coordinated database dump"
"${COMPOSE[@]}" exec -T postgres pg_dump \
  --username sutra_owner --dbname sutra --format=custom --no-owner --no-privileges > "$stage/postgres.dump"
[[ -s "$stage/postgres.dump" ]] || die "PostgreSQL dump is empty"
[[ "$(head -c 5 "$stage/postgres.dump")" == PGDMP ]] || die "PostgreSQL dump header is invalid"

volume_name() {
  local logical="$1" output count
  output="$(docker volume ls --quiet \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
    --filter "label=com.docker.compose.volume=$logical")"
  count="$(grep -c . <<<"$output" || true)"
  [[ "$count" == 1 ]] || die "Expected one Compose volume for $logical, found $count"
  printf '%s\n' "$output"
}
archive_volume() {
  local logical="$1" target="$2" volume
  volume="$(volume_name "$logical")"
  docker run --rm --network none --read-only --user 0:0 \
    --cap-drop ALL --cap-add DAC_READ_SEARCH \
    --security-opt no-new-privileges:true \
    --volume "$volume:/source:ro" --volume "$stage:/backup" "$HELPER_IMAGE" \
    sh -ec "tar -C /source -cf /backup/$target ."
}

log "Archiving runtime and application volumes"
archive_volume sutra_runtime_config runtime-config.tar
archive_volume sutra_application_data application-data.tar
install -m 0600 "$DOCKER_ENV" "$stage/docker.env"
install -m 0600 "$ENV_EC2" "$stage/env.ec2"

git_revision="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)"
export SUTRA_MANIFEST_STAGE="$stage" SUTRA_MANIFEST_ID="$backup_id" SUTRA_MANIFEST_GIT="$git_revision"
python3 <<'PY'
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

root = Path(os.environ["SUTRA_MANIFEST_STAGE"])
names = ["postgres.dump", "runtime-config.tar", "application-data.tar", "docker.env", "env.ec2"]
files = {}
for name in names:
    path = root / name
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    files[name] = {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}
manifest = {
    "schema": "sutra.ec2-encrypted-backup.v1",
    "backupId": os.environ["SUTRA_MANIFEST_ID"],
    "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "gitRevision": os.environ["SUTRA_MANIFEST_GIT"],
    "database": {"name": "sutra", "format": "postgres-custom"},
    "files": files,
}
(root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
os.chmod(root / "manifest.json", 0o600)
PY

tar -C "$stage" --numeric-owner --owner=0 --group=0 -cf "$plaintext" \
  manifest.json postgres.dump runtime-config.tar application-data.tar docker.env env.ec2
age --encrypt --recipient "$AGE_RECIPIENT" --output "$artifact" "$plaintext"
[[ -s "$artifact" ]] || die "Encrypted backup is empty"
chmod 0600 "$artifact"
(cd "$BACKUP_ROOT" && sha256sum "$(basename "$artifact")") > "$checksum"
chmod 0600 "$checksum"
artifact_complete=true

if [[ -n "$S3_URI" ]]; then
  destination="${S3_URI%/}/$backup_id"
  log "Uploading encrypted backup to offsite object storage"
  aws s3 cp "$artifact" "$destination/$(basename "$artifact")" --sse AES256 --only-show-errors
  # The checksum is deliberately uploaded last and is the completion marker.
  aws s3 cp "$checksum" "$destination/$(basename "$checksum")" --sse AES256 --only-show-errors
  log "Offsite completion marker written: $destination/$(basename "$checksum")"
fi

if [[ "$app_was_running" == true ]]; then "${COMPOSE[@]}" up -d --wait app; fi
if [[ "$worker_was_running" == true ]]; then "${COMPOSE[@]}" start notification-worker; fi
services_recovered=true

# Delete only recognized, aged artifacts, while always preserving the newest N.
mapfile -t artifacts < <(find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'sutra-*.tar.age' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
for (( index=MIN_LOCAL_COPIES; index<${#artifacts[@]}; index++ )); do
  candidate="${artifacts[$index]}"
  if find "$candidate" -maxdepth 0 -type f -mtime "+$RETENTION_DAYS" -print -quit | grep -q .; then
    rm -f -- "$candidate" "$candidate.sha256"
  fi
done

log "Backup complete: $artifact"
