#!/usr/bin/env bash
set -euo pipefail

# Secure, interactive private-beta configuration for invitation email. The API
# key is read without echo and is never accepted as a command-line argument,
# avoiding shell history and process-list disclosure. It is written only to the
# already ignored, mode-0600 runtime environment on encrypted EBS.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_ENV="${ROOT}/.sutra/docker.env"
OPERATOR_ENV="${ROOT}/deploy/ec2/.env.ec2"
COMPOSE_FILE="${ROOT}/deploy/ec2/compose.prod.yaml"

if [[ ! -t 0 || ! -t 1 ]]; then
  echo "Run this command interactively so the API key can be entered without echo." >&2
  exit 1
fi
if [[ ! -f "${RUNTIME_ENV}" || ! -f "${OPERATOR_ENV}" ]]; then
  echo "Sutra runtime configuration is missing; run deploy/ec2/bootstrap.sh first." >&2
  exit 1
fi

read -r -p "Verified sender (for example Sutra <access@sutracmdb.com>): " invitation_from
read -r -p "Provider (resend or sendgrid): " invitation_provider
case "${invitation_provider}" in
  resend) default_url="https://api.resend.com/emails" ;;
  sendgrid) default_url="https://api.sendgrid.com/v3/mail/send" ;;
  *) echo "Provider must be exactly resend or sendgrid." >&2; exit 1 ;;
esac
read -r -p "HTTPS email API URL [${default_url}]: " invitation_url
invitation_url="${invitation_url:-${default_url}}"
read -r -s -p "Email API key (input hidden): " invitation_key
echo

if [[ ! "${invitation_from}" =~ ^[^$'\r\n']+\<[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+\>$ ]]; then
  echo "Enter a valid display-name sender with a verified email address." >&2
  unset invitation_key
  exit 1
fi
if [[ ! "${invitation_url}" =~ ^https://[^[:space:]]+$ ]]; then
  echo "The email API URL must be public HTTPS." >&2
  unset invitation_key
  exit 1
fi
if (( ${#invitation_key} < 8 )) || [[ "${invitation_key}" == *$'\n'* || "${invitation_key}" == *$'\r'* ]]; then
  echo "The email API key is invalid." >&2
  unset invitation_key
  exit 1
fi

umask 077
tmp="$(mktemp "${ROOT}/.sutra/docker.env.invitation.XXXXXX")"
cleanup() {
  unset invitation_key
  rm -f "${tmp}"
}
trap cleanup EXIT INT TERM

awk '!/^SUTRA_INVITATION_(FROM|EMAIL_PROVIDER|EMAIL_API_URL|EMAIL_API_KEY)=/' "${RUNTIME_ENV}" > "${tmp}"
{
  printf 'SUTRA_INVITATION_FROM=%s\n' "${invitation_from}"
  printf 'SUTRA_INVITATION_EMAIL_PROVIDER=%s\n' "${invitation_provider}"
  printf 'SUTRA_INVITATION_EMAIL_API_URL=%s\n' "${invitation_url}"
  printf 'SUTRA_INVITATION_EMAIL_API_KEY=%s\n' "${invitation_key}"
} >> "${tmp}"
chmod 0600 "${tmp}"
mv "${tmp}" "${RUNTIME_ENV}"
trap - EXIT INT TERM
unset invitation_key

docker compose -f "${COMPOSE_FILE}" \
  --env-file "${OPERATOR_ENV}" --env-file "${RUNTIME_ENV}" \
  up -d --no-deps --force-recreate app >/dev/null

echo "Invitation email configuration installed and the app was restarted."
echo "Send a controlled invitation and confirm Sutra reports provider accepted before checking the inbox/spam folder."
