#!/usr/bin/env bash
# Verify or restore an encrypted Sutra EC2 backup. Restores are destructive and
# require an explicit phrase; preflight is always non-destructive.
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

log() { printf '[sutra-restore] %s\n' "$*"; }
die() { printf '[sutra-restore:error] %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "Required command is missing: $1"; }
usage() {
  cat >&2 <<'USAGE'
Usage:
  restore-prod.sh --from=/var/backups/sutra/sutra-*.tar.age \
    --identity=/secure/off-host/identity.txt --preflight

  restore-prod.sh --from=/var/backups/sutra/sutra-*.tar.age \
    --identity=/secure/off-host/identity.txt --confirm-restore=sutra-prod
USAGE
  exit 64
}

source_artifact=""
identity_file=""
preflight=false
confirmed=false
for argument in "$@"; do
  case "$argument" in
    --from=*) source_artifact="${argument#*=}" ;;
    --identity=*) identity_file="${argument#*=}" ;;
    --preflight) preflight=true ;;
    --confirm-restore=sutra-prod) confirmed=true ;;
    -h|--help) usage ;;
    *) die "Unknown or incomplete argument: $argument (use --from= and --identity=)" ;;
  esac
done
[[ -n "$source_artifact" && -n "$identity_file" ]] || usage
[[ "$preflight" == true || "$confirmed" == true ]] || die "Choose --preflight or --confirm-restore=sutra-prod"
[[ "$preflight" != true || "$confirmed" != true ]] || die "Preflight and destructive restore are separate operations"

CONFIG_FILE="${SUTRA_BACKUP_CONFIG:-/etc/sutra/backup.conf}"
if [[ -f "$CONFIG_FILE" ]]; then
  config_uid="$(stat -c '%u' "$CONFIG_FILE")"
  config_mode="$(stat -c '%a' "$CONFIG_FILE")"
  [[ "$config_uid" == 0 ]] || die "$CONFIG_FILE must be owned by root"
  (( (8#$config_mode & 8#022) == 0 )) || die "$CONFIG_FILE must not be group/world writable"
  # shellcheck disable=SC1090
  set -a; source "$CONFIG_FILE"; set +a
fi

BACKUP_ROOT="$(realpath -m "${SUTRA_BACKUP_ROOT:-/var/backups/sutra}")"
REPO_ROOT="${SUTRA_REPO_ROOT:-/opt/sutra}"
COMPOSE_PROJECT="${SUTRA_COMPOSE_PROJECT:-sutra-prod}"
HELPER_IMAGE="${SUTRA_BACKUP_HELPER_IMAGE:-postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15}"
for command in age docker flock python3 realpath sha256sum stat; do require "$command"; done
[[ "$BACKUP_ROOT" == /var/backups/sutra || "$BACKUP_ROOT" == /var/backups/sutra/* ]] || die "Backup root is outside the protected path"
[[ -f "$BACKUP_ROOT/.sutra-backup-root" && "$(cat "$BACKUP_ROOT/.sutra-backup-root")" == sutra-production-backups-v1 ]] || die "Backup root marker is missing or invalid"
source_artifact="$(realpath "$source_artifact")"
[[ "$source_artifact" == "$BACKUP_ROOT"/sutra-*.tar.age ]] || die "Backup must be a recognized artifact directly under $BACKUP_ROOT"
[[ -f "$source_artifact.sha256" ]] || die "Completion checksum is missing; the backup may be incomplete"
identity_file="$(realpath "$identity_file")"
[[ -f "$identity_file" && ! -L "$identity_file" ]] || die "Age identity must be a regular non-symlink file"
identity_mode="$(stat -c '%a' "$identity_file")"
(( (8#$identity_mode & 8#077) == 0 )) || die "Age identity must have mode 0600 or stricter"

exec 9>"$BACKUP_ROOT/.backup.lock"
flock -n 9 || die "Another backup or restore is already running"
(cd "$BACKUP_ROOT" && sha256sum --check --status "$(basename "$source_artifact.sha256")") || die "Encrypted artifact checksum does not match"

stage="$(mktemp -d "$BACKUP_ROOT/.restore.stage.XXXXXX")"
preserve_stage=false
cleanup() {
  local rc=$?
  if [[ "$preserve_stage" == true ]]; then
    printf '[sutra-restore:error] Emergency recovery material preserved at %s\n' "$stage" >&2
  else
    rm -rf -- "$stage"
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

age --decrypt --identity "$identity_file" --output "$stage/outer.tar" "$source_artifact"
export SUTRA_RESTORE_STAGE="$stage"
python3 <<'PY'
import hashlib
import json
import os
import tarfile
from pathlib import Path, PurePosixPath

stage = Path(os.environ["SUTRA_RESTORE_STAGE"])
expected = {
    "manifest.json", "postgres.dump", "runtime-config.tar",
    "application-data.tar", "docker.env", "env.ec2",
}
with tarfile.open(stage / "outer.tar", "r:") as archive:
    members = archive.getmembers()
    names = [member.name for member in members]
    if set(names) != expected or len(names) != len(expected):
        raise SystemExit("Encrypted archive has unexpected, duplicate, or missing entries")
    if any(not member.isfile() or member.size > 200 * 1024**3 for member in members):
        raise SystemExit("Encrypted archive contains an unsafe entry")
    for member in members:
        source = archive.extractfile(member)
        if source is None:
            raise SystemExit(f"Cannot read {member.name}")
        target = stage / member.name
        with target.open("xb") as output:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
        target.chmod(0o600)

manifest = json.loads((stage / "manifest.json").read_text(encoding="utf-8"))
if (
    manifest.get("schema") != "sutra.ec2-encrypted-backup.v1"
    or manifest.get("database") != {"name": "sutra", "format": "postgres-custom"}
    or set(manifest.get("files", {})) != expected - {"manifest.json"}
):
    raise SystemExit("Backup manifest contract is invalid")
for name, expected_file in manifest["files"].items():
    path = stage / name
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if path.stat().st_size != expected_file.get("bytes") or digest.hexdigest() != expected_file.get("sha256"):
        raise SystemExit(f"Backup payload integrity check failed: {name}")
if (stage / "postgres.dump").read_bytes()[:5] != b"PGDMP":
    raise SystemExit("PostgreSQL custom dump header is invalid")

def validate_inner(name):
    with tarfile.open(stage / name, "r:") as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts:
                raise SystemExit(f"Unsafe path in {name}: {member.name}")
            if not (member.isfile() or member.isdir()):
                raise SystemExit(f"Links or special files are prohibited in {name}: {member.name}")

validate_inner("runtime-config.tar")
validate_inner("application-data.tar")

secrets = {}
for line in (stage / "docker.env").read_text(encoding="utf-8").splitlines():
    if not line or line.startswith("#"):
        continue
    key, separator, value = line.partition("=")
    if not separator or not key or "\x00" in value or "\n" in value:
        raise SystemExit("docker.env is malformed")
    secrets[key] = value
for required in ("SUTRA_POSTGRES_OWNER_PASSWORD", "SUTRA_POSTGRES_APP_PASSWORD", "SUTRA_JOB_RUNNER_TOKEN"):
    if required not in secrets:
        raise SystemExit(f"docker.env lacks {required}")
if not all(40 <= len(secrets[key]) <= 128 and all(char.isalnum() or char in "-_" for char in secrets[key]) for key in ("SUTRA_POSTGRES_OWNER_PASSWORD", "SUTRA_POSTGRES_APP_PASSWORD")):
    raise SystemExit("Restored database passwords have an invalid format")
if len(secrets["SUTRA_JOB_RUNNER_TOKEN"]) != 64 or any(char not in "0123456789abcdefABCDEF" for char in secrets["SUTRA_JOB_RUNNER_TOKEN"]):
    raise SystemExit("Restored job token has an invalid format")
PY
rm -f -- "$stage/outer.tar"

docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --volume "$stage:/backup:ro" "$HELPER_IMAGE" \
  pg_restore --list /backup/postgres.dump >/dev/null
log "Preflight passed: encryption, checksums, paths, secrets and PostgreSQL dump are valid"
if [[ "$preflight" == true ]]; then exit 0; fi

COMPOSE_FILE="$REPO_ROOT/deploy/ec2/compose.prod.yaml"
ENV_EC2="$REPO_ROOT/deploy/ec2/.env.ec2"
DOCKER_ENV="$REPO_ROOT/.sutra/docker.env"
[[ -d "$REPO_ROOT/.git" && -f "$COMPOSE_FILE" && -f "$ENV_EC2" && -f "$DOCKER_ENV" ]] || die "Current Sutra deployment is incomplete"
cd "$REPO_ROOT"
COMPOSE=(docker compose --project-name "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_EC2" --env-file "$DOCKER_ENV")
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" up -d --wait postgres

volume_name() {
  local logical="$1" output count
  output="$(docker volume ls --quiet --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --filter "label=com.docker.compose.volume=$logical")"
  count="$(grep -c . <<<"$output" || true)"
  [[ "$count" == 1 ]] || die "Expected one Compose volume for $logical, found $count"
  printf '%s\n' "$output"
}
archive_volume() {
  local logical="$1" target="$2" volume
  volume="$(volume_name "$logical")"
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --volume "$volume:/source:ro" --volume "$stage:/backup" "$HELPER_IMAGE" \
    sh -ec "tar -C /source -cf /backup/$target ."
}
restore_volume() {
  local logical="$1" source="$2" volume
  volume="$(volume_name "$logical")"
  docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
    --volume "$volume:/target" --volume "$stage:/backup:ro" "$HELPER_IMAGE" \
    sh -ec "find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -C /target -xf /backup/$source"
}
recreate_database() {
  "${COMPOSE[@]}" exec -T postgres psql --username sutra_owner --dbname postgres \
    --set ON_ERROR_STOP=1 \
    --command 'DROP DATABASE IF EXISTS sutra WITH (FORCE)' \
    --command 'CREATE DATABASE sutra OWNER sutra_owner'
}
restore_database() {
  local source="$1"
  recreate_database
  "${COMPOSE[@]}" exec -T postgres pg_restore --username sutra_owner --dbname sutra \
    --exit-on-error --no-owner --no-privileges < "$source"
}
read_secret() {
  local file="$1" key="$2"
  sed -n "s/^${key}=//p" "$file" | head -n1
}
align_role_passwords() {
  local env_file="$1" owner_password app_password
  owner_password="$(read_secret "$env_file" SUTRA_POSTGRES_OWNER_PASSWORD)"
  app_password="$(read_secret "$env_file" SUTRA_POSTGRES_APP_PASSWORD)"
  [[ "$owner_password" =~ ^[A-Za-z0-9_-]{40,128}$ && "$app_password" =~ ^[A-Za-z0-9_-]{40,128}$ ]] || die "Database secret format is unsafe"
  printf "ALTER ROLE sutra_owner PASSWORD '%s';\nALTER ROLE sutra_app PASSWORD '%s';\n" "$owner_password" "$app_password" | \
    "${COMPOSE[@]}" exec -T postgres psql --username sutra_owner --dbname postgres --set ON_ERROR_STOP=1
}
install_environment() {
  local docker_source="$1" ec2_source="$2"
  install -m 0600 "$docker_source" "$DOCKER_ENV"
  install -m 0600 "$ec2_source" "$ENV_EC2"
}
run_migrations() { "${COMPOSE[@]}" run --rm --no-deps migrate; }

app_was_running=false
worker_was_running=false
"${COMPOSE[@]}" ps --services --filter status=running | grep -Fxq app && app_was_running=true
"${COMPOSE[@]}" ps --services --filter status=running | grep -Fxq notification-worker && worker_was_running=true
if [[ "$worker_was_running" == true ]]; then "${COMPOSE[@]}" stop -t 30 notification-worker; fi
if [[ "$app_was_running" == true ]]; then "${COMPOSE[@]}" stop -t 30 app; fi

log "Capturing an automatic rollback point before destructive restore"
"${COMPOSE[@]}" exec -T postgres pg_dump --username sutra_owner --dbname sutra \
  --format=custom --no-owner --no-privileges > "$stage/rollback-postgres.dump"
archive_volume sutra_runtime_config rollback-runtime-config.tar
archive_volume sutra_application_data rollback-application-data.tar
install -m 0600 "$DOCKER_ENV" "$stage/rollback-docker.env"
install -m 0600 "$ENV_EC2" "$stage/rollback-env.ec2"

restore_failed=false
if ! {
  restore_database "$stage/postgres.dump"
  restore_volume sutra_runtime_config runtime-config.tar
  restore_volume sutra_application_data application-data.tar
  align_role_passwords "$stage/docker.env"
  install_environment "$stage/docker.env" "$stage/env.ec2"
  run_migrations
}; then
  restore_failed=true
  log "Restore failed; applying the automatic rollback point"
  if ! {
    restore_database "$stage/rollback-postgres.dump"
    restore_volume sutra_runtime_config rollback-runtime-config.tar
    restore_volume sutra_application_data rollback-application-data.tar
    align_role_passwords "$stage/rollback-docker.env"
    install_environment "$stage/rollback-docker.env" "$stage/rollback-env.ec2"
    run_migrations
  }; then
    preserve_stage=true
    die "Restore and rollback both failed; application remains stopped"
  fi
fi

if [[ "$app_was_running" == true ]]; then "${COMPOSE[@]}" up -d --wait app; fi
if [[ "$worker_was_running" == true ]]; then "${COMPOSE[@]}" start notification-worker; fi
if [[ "$restore_failed" == true ]]; then die "Restore failed; the verified rollback point was restored"; fi
log "Restore completed and the application returned healthy"
