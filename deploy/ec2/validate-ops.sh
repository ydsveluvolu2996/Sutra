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
  "$EC2/bootstrap.sh" "$EC2/redeploy.sh" "$EC2/release-update.sh" \
  "$EC2/sync-zoho-runtime.sh"
[[ -x "$EC2/backup-prod.sh" && -x "$EC2/restore-prod.sh" && -x "$EC2/release-update.sh" ]]

ruby -e '
  require "yaml"
  document = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
  abort "CloudFormation document is not a mapping" unless document.is_a?(Hash)
  abort "CloudFormation Resources are missing" unless document["Resources"].is_a?(Hash)
' "$TEMPLATE"

python3 - "$TEMPLATE" "$EC2/backup-prod.sh" "$EC2/restore-prod.sh" \
  "$EC2/release-update.sh" "$EC2/redeploy.sh" "$EC2/Caddyfile" \
  "$EC2/cloudflared-config.yml.example" "$EC2/maintenance/security.txt" \
  "$EC2/compose.prod.yaml" "$EC2/.env.ec2.example" "$EC2/sutra.service" \
  "$EC2/sync-zoho-runtime.sh" <<'PY'
from pathlib import Path
import sys

template = Path(sys.argv[1]).read_text(encoding="utf-8")
backup = Path(sys.argv[2]).read_text(encoding="utf-8")
restore = Path(sys.argv[3]).read_text(encoding="utf-8")
release_update = Path(sys.argv[4]).read_text(encoding="utf-8")
redeploy = Path(sys.argv[5]).read_text(encoding="utf-8")
caddy = Path(sys.argv[6]).read_text(encoding="utf-8")
tunnel = Path(sys.argv[7]).read_text(encoding="utf-8")
security_text = Path(sys.argv[8]).read_text(encoding="utf-8")
compose = Path(sys.argv[9]).read_text(encoding="utf-8")
env_template = Path(sys.argv[10]).read_text(encoding="utf-8")
unit = Path(sys.argv[11]).read_text(encoding="utf-8")
sync_runtime = Path(sys.argv[12]).read_text(encoding="utf-8")

required_template = [
    "Default: t3a.large",
    "Default: 15",
    "Default: ami-07e5ce642bbc48c0d",
    "SutraAppImage:",
    "/sutra/production/cloudflare-tunnel-credentials",
    "repository/sutra/app",
    # Notification delivery IAM: exactly two pull-only repositories, one
    # read-only secret prefix, and SES only behind an explicit identity ARN.
    "repository/sutra/notification-worker",
    "Action: secretsmanager:GetSecretValue",
    "secret:sutra/notifications/*",
    "PolicyName: ReadOnlyExactZohoRuntimeSecret",
    "secret:sutra/runtime/zoho-*",
    "PolicyName: ManageOnlySutraCustomerAwsCredentialSecrets",
    "secretsmanager:CreateSecret",
    "secretsmanager:DescribeSecret",
    "secretsmanager:PutSecretValue",
    "secretsmanager:UpdateSecretVersionStage",
    "Sid: ReadOnlyCurrentOrPendingSutraCustomerCredentialVersion",
    "secretsmanager:VersionStage:",
    'secretsmanager:VersionId: "false"',
    "- AWSCURRENT",
    "- SUTRAPENDING",
    "secretsmanager:DeleteSecret",
    "secret:sutra/customer-aws-credentials/v1/*",
    "secretsmanager:RecoveryWindowInDays: 7",
    "Condition: GrantNotificationEmailSending",
    'Action: ["ses:SendEmail", "ses:SendRawEmail"]',
    "Resource: { Ref: NotificationSesIdentityArn }",
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
    # Notification delivery must never be granted through a wildcard.
    "secretsmanager:*",
    "secretsmanager:GetSecretValue*",
    "secret:*",
    "ses:*",
    "identity/*",
    "repository/sutra/*",
    "secretsmanager:ListSecrets",
    "secretsmanager:RestoreSecret",
    "secretsmanager:ReplicateSecretToRegions",
    "secretsmanager:PutResourcePolicy",
    "secretsmanager:TagResource",
    "secretsmanager:UntagResource",
]
for fragment in prohibited_template:
    if fragment in template:
        raise SystemExit(f"Minimal-cost template unexpectedly contains: {fragment}")

customer_secret_prefix = "secret:sutra/customer-aws-credentials/v1/*"
if template.count(customer_secret_prefix) != 3:
    raise SystemExit("Customer AWS credential permissions must use exactly three path-scoped resources")
if template.count("Action: secretsmanager:DeleteSecret") != 1:
    raise SystemExit("Customer AWS credential deletion must have one reviewed grant")
delete_grant = template[template.index("Sid: ScheduleSutraCustomerAwsCredentialSecretDeletion"):]
delete_grant = delete_grant[:delete_grant.index("- PolicyName:")]
for fragment in (
    "Action: secretsmanager:DeleteSecret",
    customer_secret_prefix,
    "NumericEquals:",
    "secretsmanager:RecoveryWindowInDays: 7",
):
    if fragment not in delete_grant:
        raise SystemExit(f"Recoverable customer credential deletion is missing: {fragment}")

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
    'fetch_public "/.well-known/security.txt" "security-well-known" 3',
    'fetch_public "/security.txt" "security-root" 3',
    'cmp -s "$PUBLIC_BODY" "$security_expected"',
    'cmp -s "$PUBLIC_BODY" "$security_well_known_body"',
    'cp -a "$ROOT/.sutra/cloudflared/config.yml" "$BACKUP_DIR/cloudflared-config.yml"',
    '--force-recreate caddy',
    '--force-recreate cloudflared',
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
if release_update.count('cmp -s "$PUBLIC_BODY" "$security_expected"') != 2:
    raise SystemExit("Both public security.txt paths must be byte-compared with the selected release")
security_well_known = release_update.index(
    'fetch_public "/.well-known/security.txt" "security-well-known" 3'
)
security_root = release_update.index('fetch_public "/security.txt" "security-root" 3')
security_cross_compare = release_update.index(
    'cmp -s "$PUBLIC_BODY" "$security_well_known_body"'
)
if not security_well_known < security_root < security_cross_compare < public_gate:
    raise SystemExit("Both security.txt byte checks must execute inside the pre-commit public gate")
for fragment in (
    "TARGET_STATE_DIR",
    "Restoring the verified application-data snapshot for the selected release",
):
    if fragment in release_update:
        raise SystemExit(f"Release update may not replace current customer state from history: {fragment}")

for fragment in (
    "CLOUDFLARED_CONFIG_TEMPLATE=",
    "tunnel --config /etc/cloudflared/release-config.yml ingress validate",
    "install -o 65532 -g 65532 -m 0400",
    'cmp -s "$CLOUDFLARED_CONFIG_TEMPLATE" "$CLOUDFLARED_CONFIG"',
    "--no-deps --force-recreate caddy",
    "--no-deps --force-recreate cloudflared",
):
    if fragment not in redeploy:
        raise SystemExit(f"Redeploy edge-refresh contract is missing: {fragment}")
tunnel_validate = redeploy.index(
    "tunnel --config /etc/cloudflared/release-config.yml ingress validate"
)
tunnel_activate = redeploy.index(
    'mv -f "$staged_cloudflared_config" "$CLOUDFLARED_CONFIG"'
)
caddy_recreate = redeploy.index("--no-deps --force-recreate caddy")
tunnel_recreate = redeploy.index("--no-deps --force-recreate cloudflared")
if not tunnel_validate < tunnel_activate < caddy_recreate < tunnel_recreate:
    raise SystemExit(
        "Redeploy must validate/activate tunnel routing, then recreate Caddy before cloudflared"
    )
if redeploy.count("$CLOUDFLARED_CREDENTIAL") != 2:
    raise SystemExit(
        "Redeploy may only reference the named-tunnel credential in its existence check"
    )

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
if compose.count('SUTRA_AWS_STATIC_KEYS_ENABLED: "${SUTRA_AWS_STATIC_KEYS_ENABLED:-false}"') != 1:
    raise SystemExit("The live application must expose one fail-closed static-key emergency switch")
env_lines = env_template.splitlines()
if env_lines.count("SUTRA_AWS_STATIC_KEYS_ENABLED=false") != 1:
    raise SystemExit(
        "deploy/ec2/.env.ec2.example must persist one disabled static-key emergency switch"
    )
if "SUTRA_AWS_STATIC_KEYS_ENABLED=true" in env_lines:
    raise SystemExit("The committed EC2 operator template must not enable static-key onboarding")
for fragment in (
    "The AWS static-key emergency switch was not preserved in the staged release.",
    'export SUTRA_AWS_STATIC_KEYS_ENABLED="$staged_static_keys_enabled"',
):
    if fragment not in release_update:
        raise SystemExit(f"Immutable release static-key switch persistence is missing: {fragment}")
for fragment in (
    'static_keys_enabled="${static_keys_enabled:-false}"',
    'export SUTRA_AWS_STATIC_KEYS_ENABLED="$static_keys_enabled"',
):
    if fragment not in redeploy:
        raise SystemExit(f"Redeploy static-key emergency switch handling is missing: {fragment}")
if "SUTRA_AWS_STATIC_KEYS_ENABLED" in sync_runtime:
    raise SystemExit(
        "sync-zoho-runtime.sh must not read, write, or manage the operator-owned static-key switch"
    )
for fragment in (
    "AWS_REGION: ${AWS_REGION:-ap-south-1}",
    "AWS_DEFAULT_REGION: ${AWS_REGION:-ap-south-1}",
):
    if fragment not in compose:
        raise SystemExit(f"Static-key Secrets Manager Region configuration is missing: {fragment}")

# Real notification delivery must never become live merely by deploying the
# committed template. Both switches ship off, the worker stays profile-gated,
# and no immutable worker image is baked in.
for required in ("SUTRA_NOTIFICATIONS_ENABLED=false", "COMPOSE_PROFILES="):
    if required not in env_lines:
        raise SystemExit(
            f"deploy/ec2/.env.ec2.example must ship the inert notification switch: {required}"
        )
for prohibited in (
    "SUTRA_NOTIFICATIONS_ENABLED=true",
    "COMPOSE_PROFILES=notifications",
):
    if prohibited in env_lines:
        raise SystemExit(
            f"deploy/ec2/.env.ec2.example must not enable notification delivery: {prohibited}"
        )
if any(line.startswith("SUTRA_NOTIFICATION_WORKER_IMAGE=") for line in env_lines):
    raise SystemExit(
        "deploy/ec2/.env.ec2.example must leave SUTRA_NOTIFICATION_WORKER_IMAGE unset"
    )
if 'profiles: ["notifications"]' not in compose:
    raise SystemExit("The notification worker must remain profile-gated")
if "sutra-notification-worker:unavailable" not in compose:
    raise SystemExit("The notification worker must fail closed without a published image")
ses_parameter = template.index("  NotificationSesIdentityArn:\n    Type: String")
if 'Default: ""' not in template[ses_parameter:ses_parameter + 200]:
    raise SystemExit(
        "NotificationSesIdentityArn must ship empty so the committed template grants no SES permission"
    )
unit_directives = [
    line for line in unit.splitlines() if not line.lstrip().startswith("#")
]
if any("--profile" in line for line in unit_directives):
    raise SystemExit(
        "deploy/ec2/sutra.service must not hardcode a Compose profile; "
        "operators set COMPOSE_PROFILES in deploy/ec2/.env.ec2 instead"
    )
PY

if [[ "${1:-}" == --online ]]; then
  profile="${AWS_PROFILE:-sutra-administrator}"
  region="${AWS_REGION:-ap-south-1}"
  aws cloudformation validate-template --profile "$profile" --region "$region" \
    --template-body "file://$TEMPLATE" --output json >/dev/null
fi

printf 'Sutra EC2 operations validation passed%s.\n' "$( [[ "${1:-}" == --online ]] && printf ' (including AWS)' || true )"
