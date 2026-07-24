#!/usr/bin/env bash
# Offline contract checks for the EC2 infrastructure and recovery tooling.
# Add --online to also ask AWS CloudFormation to validate the template.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EC2="$ROOT/deploy/ec2"
TEMPLATE="$EC2/cloudformation-single-node.yaml"

grep -Fxq '!deploy/ec2/.env.ec2.example' "$ROOT/.dockerignore" || {
  printf 'Immutable image would omit deploy/ec2/.env.ec2.example\n' >&2
  exit 1
}

bash -n "$EC2/backup-prod.sh" "$EC2/restore-prod.sh" \
  "$EC2/bootstrap.sh" "$EC2/redeploy.sh" "$EC2/release-update.sh"
[[ -x "$EC2/backup-prod.sh" && -x "$EC2/restore-prod.sh" && -x "$EC2/release-update.sh" ]]

ruby -e '
  require "yaml"
  document = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
  abort "CloudFormation document is not a mapping" unless document.is_a?(Hash)
  abort "CloudFormation Resources are missing" unless document["Resources"].is_a?(Hash)
' "$TEMPLATE"

python3 - "$TEMPLATE" "$EC2/backup-prod.sh" "$EC2/restore-prod.sh" \
  "$EC2/release-update.sh" "$EC2/Caddyfile" \
  "$EC2/cloudflared-config.yml.example" "$EC2/maintenance/security.txt" \
  "$EC2/compose.prod.yaml" <<'PY'
from pathlib import Path
import sys

template = Path(sys.argv[1]).read_text(encoding="utf-8")
backup = Path(sys.argv[2]).read_text(encoding="utf-8")
restore = Path(sys.argv[3]).read_text(encoding="utf-8")
release_update = Path(sys.argv[4]).read_text(encoding="utf-8")
caddy = Path(sys.argv[5]).read_text(encoding="utf-8")
tunnel = Path(sys.argv[6]).read_text(encoding="utf-8")
security_text = Path(sys.argv[7]).read_text(encoding="utf-8")
compose = Path(sys.argv[8]).read_text(encoding="utf-8")

required_template = [
    "Default: t3a.large",
    "Default: 15",
    "Default: ami-07e5ce642bbc48c0d",
    "SutraAppImage:",
    "/sutra/production/cloudflare-tunnel-credentials",
    "repository/sutra/app",
    "HttpTokens: required",
    "HttpPutResponseHopLimit: 2",
    "CPUCredits: standard",
    "Monitoring: false",
    "Encrypted: true",
    "DeleteOnTermination: false",
    "AWS::Scheduler::Schedule",
    "PolicyName: DeterministicSsmManagedNodeCore",
    "PolicyName: AssumeOnlyDedicatedSutraCustomerRoles",
    "Sid: DenyAssumeRoleOutsideSutraRoleNamespace",
    "NotResource:",
    "arn:${AWS::Partition}:iam::*:role/sutra/*",
    "docker cp \"$RELEASE_CONTAINER:/app/deploy/ec2/.\"",
    "install -m 0755 deploy/ec2/release-update.sh /usr/local/sbin/sutra-release-update",
]
for fragment in required_template:
    if fragment not in template:
        raise SystemExit(f"CloudFormation contract is missing: {fragment}")

prohibited_template = [
    "SecurityGroupIngress:",
    "AWS::EC2::EIP",
    "AWS::S3::Bucket",
    "AWS::Logs::LogGroup",
    "AWS::CloudWatch::Alarm",
    "cloudflared-sutra.service",
    "sutra-backup.timer sutra-max-runtime.timer",
    "git clone",
    "git -C /opt/sutra",
    "AmazonSSMManagedInstanceCore",
    "arn:${AWS::Partition}:iam::*:role/*",
    "resolve:ssm:/aws/service/canonical/ubuntu",
]
for fragment in prohibited_template:
    if fragment in template:
        raise SystemExit(f"Minimal-cost template unexpectedly contains: {fragment}")

credentials = template.index(".sutra/cloudflared/credentials.json")
bootstrap = template.index("bash deploy/ec2/bootstrap.sh")
if credentials >= bootstrap:
    raise SystemExit("Tunnel credentials must be materialized before bootstrap")
if "@sha256:[a-f0-9]{64}" not in template:
    raise SystemExit("SutraAppImage must reject mutable image tags")

for fragment in (
    "age --encrypt",
    "SUTRA_BACKUP_REQUIRE_OFFSITE",
    "sha256sum",
    "SUTRA_BACKUP_MIN_LOCAL_COPIES",
    "s3 cp",
    "/run/lock/sutra-data-mutation.lock",
):
    if fragment not in backup:
        raise SystemExit(f"Backup contract is missing: {fragment}")
for fragment in (
    "--confirm-restore=sutra-prod",
    "age --decrypt",
    "Preflight passed",
    "automatic rollback point",
    "preserve_stage=true",
    "/run/lock/sutra-data-mutation.lock",
):
    if fragment not in restore:
        raise SystemExit(f"Restore contract is missing: {fragment}")
for fragment in (
    "archive_application_data",
    "restore_application_data",
    "application-data.tar.gz.sha256",
    "The Sutra application did not quiesce",
    "ALL_PROFILES_COMPOSE=",
    "--profile \"*\"",
    "recovering the prior application state and host bundle",
    "--ulimit fsize=536870912:536870912",
    "--cap-add DAC_READ_SEARCH",
    "--cap-add DAC_OVERRIDE",
    "--cap-add CHOWN",
    "--user 0:0",
    "trap 'exit 130' INT",
    "verify_public_release",
    "x-sutra-release-image:",
    "Sitemap: $PUBLIC_ORIGIN/sitemap.xml",
    "x-robots-tag:.*noindex",
    "RELEASE_COMMITTED=true",
    "maintenance/security.txt",
    "/run/lock/sutra-data-mutation.lock",
):
    if fragment not in release_update:
        raise SystemExit(f"Release rollback contract is missing: {fragment}")
for name, script in (("backup", backup), ("restore", restore)):
    for fragment in ("--user 0:0", "--cap-add DAC_READ_SEARCH"):
        if fragment not in script:
            raise SystemExit(f"{name.title()} volume helper contract is missing: {fragment}")
for fragment in ("--cap-add DAC_OVERRIDE", "--cap-add CHOWN"):
    if fragment not in restore:
        raise SystemExit(f"Restore volume helper contract is missing: {fragment}")
public_gate = release_update.rindex("\nverify_public_release\n")
release_commit = release_update.index("\nRELEASE_COMMITTED=true\n")
if public_gate >= release_commit:
    raise SystemExit("Public verification must complete before the release transaction commits")
for fragment in (
    "TARGET_STATE_DIR",
    "Restoring the verified application-data snapshot for the selected release",
):
    if fragment in release_update:
        raise SystemExit(f"Release update may not replace current customer state from history: {fragment}")

for fragment in (
    "not host origin.{$SUTRA_DOMAIN:sutracmdb.com} www.{$SUTRA_DOMAIN:sutracmdb.com} {$SUTRA_DOMAIN:sutracmdb.com}",
    "redir @apex_safe https://www.{$SUTRA_DOMAIN:sutracmdb.com}{uri} 308",
    "not method GET HEAD",
    "path /.well-known/security.txt /security.txt",
    "rewrite * /security.txt",
    'Content-Type "text/plain; charset=utf-8"',
    'Cloudflare-CDN-Cache-Control "public, max-age=86400, stale-while-revalidate=604800"',
    'header_up X-Forwarded-For {http.request.header.CF-Connecting-IP}',
    "header_up Host www.{$SUTRA_DOMAIN:sutracmdb.com}",
):
    if fragment not in caddy:
        raise SystemExit(f"Caddy fail-open contract is missing: {fragment}")

host_routes = (
    "- hostname: origin.sutracmdb.com",
    "- hostname: www.sutracmdb.com",
    "- hostname: sutracmdb.com",
)
positions = []
for route in host_routes:
    if tunnel.count(route) != 1:
        raise SystemExit(f"Named Tunnel must contain exactly one exact route: {route}")
    positions.append(tunnel.index(route))
catchall = "- service: http_status:404"
if tunnel.count(catchall) != 1:
    raise SystemExit("Named Tunnel must contain exactly one fail-closed catch-all")
positions.append(tunnel.index(catchall))
if positions != sorted(positions):
    raise SystemExit("Named Tunnel exact routes must precede the fail-closed catch-all")
for wildcard in ("- hostname: *.sutracmdb.com", "- hostname: '*'"):
    if wildcard in tunnel:
        raise SystemExit(f"Named Tunnel must not contain a wildcard route: {wildcard}")

expected_security_text = """Contact: https://www.sutracmdb.com/contact
Expires: 2027-07-24T23:59:00Z
Canonical: https://www.sutracmdb.com/.well-known/security.txt
Policy: https://www.sutracmdb.com/security
Preferred-Languages: en
"""
if security_text != expected_security_text:
    raise SystemExit("Caddy fail-open security.txt differs from the reviewed canonical document")
if "./maintenance:/srv/maintenance:ro" not in compose:
    raise SystemExit("Caddy's version-controlled security.txt directory is not mounted read-only")
PY

if [[ "${1:-}" == --online ]]; then
  profile="${AWS_PROFILE:-sutra-administrator}"
  region="${AWS_REGION:-ap-south-1}"
  aws cloudformation validate-template --profile "$profile" --region "$region" \
    --template-body "file://$TEMPLATE" --output json >/dev/null
fi

printf 'Sutra EC2 operations validation passed%s.\n' "$( [[ "${1:-}" == --online ]] && printf ' (including AWS)' || true )"
