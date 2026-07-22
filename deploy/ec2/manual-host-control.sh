#!/usr/bin/env bash
# Explicit operator control for the one retained Sutra private-beta host.
# This script never schedules a future transition and never changes any other
# EC2 instance. Authentication remains an interactive AWS IAM Identity Center
# session selected by profile name; static AWS credentials are rejected.
set -Eeuo pipefail

log() { printf '[sutra:host] %s\n' "$*"; }
die() { printf '[sutra:host:error] %s\n' "$*" >&2; exit 1; }

[[ "$#" -eq 1 ]] || die "Usage: manual-host-control.sh <start|stop|status>"
ACTION="$1"
[[ "$ACTION" == start || "$ACTION" == stop || "$ACTION" == status ]] || \
  die "Action must be start, stop, or status."

readonly PROFILE="${SUTRA_AWS_ADMIN_PROFILE:-sutra-administrator}"
readonly REGION="ap-south-1"
readonly EXPECTED_ACCOUNT="738663485493"
readonly INSTANCE_ID="i-0a7af7b477174a14b"

[[ "$PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "The AWS profile name is invalid."
for credential_name in \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN \
  AWS_WEB_IDENTITY_TOKEN_FILE AWS_CONTAINER_CREDENTIALS_RELATIVE_URI \
  AWS_CONTAINER_CREDENTIALS_FULL_URI; do
  [[ -z "${!credential_name:-}" ]] || die "Static or injected AWS credentials are not accepted; use the SSO profile."
done

aws_cli() {
  aws --profile "$PROFILE" --region "$REGION" --no-cli-pager --no-cli-auto-prompt "$@"
}

account_id="$(aws_cli sts get-caller-identity --query Account --output text 2>/dev/null)" || \
  die "AWS SSO is not ready. Run: aws sso login --profile $PROFILE"
[[ "$account_id" == "$EXPECTED_ACCOUNT" ]] || \
  die "Refusing AWS account $account_id; expected $EXPECTED_ACCOUNT."

read_state() {
  aws_cli ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].State.Name' \
    --output text
}

state="$(read_state)"
case "$ACTION:$state" in
  status:*)
    log "Instance $INSTANCE_ID is $state in $REGION."
    ;;
  start:stopped)
    log "Starting the exact Sutra host $INSTANCE_ID."
    aws_cli ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null
    aws_cli ec2 wait instance-running --instance-ids "$INSTANCE_ID"
    aws_cli ec2 wait instance-status-ok --instance-ids "$INSTANCE_ID"
    log "Instance $INSTANCE_ID is running and passed EC2 status checks."
    ;;
  start:pending|start:running)
    aws_cli ec2 wait instance-running --instance-ids "$INSTANCE_ID"
    aws_cli ec2 wait instance-status-ok --instance-ids "$INSTANCE_ID"
    log "Instance $INSTANCE_ID is running and passed EC2 status checks."
    ;;
  stop:running)
    log "Stopping the exact Sutra host $INSTANCE_ID."
    aws_cli ec2 stop-instances --instance-ids "$INSTANCE_ID" >/dev/null
    aws_cli ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
    log "Instance $INSTANCE_ID is stopped. EBS and small retained storage remain billable."
    ;;
  stop:stopping|stop:stopped)
    aws_cli ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
    log "Instance $INSTANCE_ID is stopped. EBS and small retained storage remain billable."
    ;;
  *)
    die "Refusing to $ACTION instance $INSTANCE_ID while its state is $state."
    ;;
esac
