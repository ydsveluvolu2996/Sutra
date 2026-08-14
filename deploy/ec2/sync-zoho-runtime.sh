#!/usr/bin/env bash
# Install the approved Zoho Mail + OIDC runtime bundle from one exact
# account-local Secrets Manager document. The secret is never printed, passed
# on a command line, or written outside the existing mode-0600 runtime env.
set -Eeuo pipefail

log() { printf '[sutra:zoho] %s\n' "$*"; }
die() { printf '[sutra:zoho:error] %s\n' "$*" >&2; exit 1; }

OPTIONAL=false
case "${1:-}" in
  "") ;;
  --optional) OPTIONAL=true ;;
  *) die "Usage: sync-zoho-runtime.sh [--optional]" ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG=/etc/sutra-release.conf
RUNTIME_ENV="$ROOT/.sutra/docker.env"
SECRET_ID=sutra/runtime/zoho

[[ "${EUID}" -eq 0 ]] || die "Run as root."
[[ -f "$CONFIG" ]] || die "$CONFIG is missing."
[[ -f "$RUNTIME_ENV" ]] || die "$RUNTIME_ENV is missing."
[[ "$(stat -c '%u' "$CONFIG")" == 0 ]] || die "$CONFIG must be owned by root."
config_mode="$(stat -c '%a' "$CONFIG")"
[[ "$config_mode" == 644 || "$config_mode" == 600 || "$config_mode" == 400 ]] || \
  die "$CONFIG has unsafe mode $config_mode."
# shellcheck disable=SC1090
source "$CONFIG"
[[ "${SUTRA_AWS_REGION:-}" =~ ^[a-z]{2}-[a-z]+-[0-9]+$ ]] || \
  die "The configured AWS Region is invalid."

umask 077
stage="$(mktemp -d "$ROOT/.sutra/zoho-runtime.XXXXXX")"
payload="$stage/secret.json"
merged="$stage/docker.env"
cleanup() {
  rm -rf "$stage"
}
trap cleanup EXIT INT TERM

if ! aws secretsmanager get-secret-value \
  --region "$SUTRA_AWS_REGION" \
  --secret-id "$SECRET_ID" \
  --query SecretString \
  --output text >"$payload" 2>/dev/null; then
  if [[ "$OPTIONAL" == true ]]; then
    log "No readable $SECRET_ID secret; preserving the current identity and mail configuration."
    exit 0
  fi
  die "The exact $SECRET_ID secret is unavailable."
fi
chmod 0600 "$payload"

# Exact names, endpoints and public aliases are deliberate. Unknown keys are
# refused so this narrowly-scoped document cannot become a generic environment
# injection channel.
jq -e '
  type == "object"
  and ((keys - [
    "SUTRA_CONTACT_FROM",
    "SUTRA_CONTACT_PROVIDER",
    "SUTRA_CONTACT_RECIPIENT",
    "SUTRA_IDENTITY_MODE",
    "SUTRA_INVITATION_EMAIL_PROVIDER",
    "SUTRA_INVITATION_FROM",
    "SUTRA_OIDC_PROVIDERS",
    "SUTRA_OIDC_TRANSACTION_KEY",
    "SUTRA_ZOHO_CLIENT_ID",
    "SUTRA_ZOHO_CLIENT_SECRET",
    "SUTRA_ZOHO_DATACENTER",
    "SUTRA_ZOHO_MAIL_ACCOUNT_ID",
    "SUTRA_ZOHO_REFRESH_TOKEN"
  ]) | length) == 0
  and .SUTRA_CONTACT_RECIPIENT == "contact@sutracmdb.com"
  and .SUTRA_CONTACT_FROM == "Sutra Contact <contact@sutracmdb.com>"
  and .SUTRA_CONTACT_PROVIDER == "zoho"
  and .SUTRA_INVITATION_FROM == "Sutra Support <support@sutracmdb.com>"
  and .SUTRA_INVITATION_EMAIL_PROVIDER == "zoho"
  and .SUTRA_ZOHO_DATACENTER == "in"
  and (.SUTRA_ZOHO_MAIL_ACCOUNT_ID | type == "string" and test("^[0-9]{6,32}$"))
  and (.SUTRA_ZOHO_CLIENT_ID | type == "string" and test("^[A-Za-z0-9._-]{8,256}$"))
  and (.SUTRA_ZOHO_CLIENT_SECRET | type == "string" and length >= 8 and length <= 512)
  and (.SUTRA_ZOHO_REFRESH_TOKEN | type == "string" and test("^[A-Za-z0-9._-]{16,2048}$"))
  and (.SUTRA_IDENTITY_MODE == "password" or .SUTRA_IDENTITY_MODE == "oidc")
  and (.SUTRA_OIDC_TRANSACTION_KEY | type == "string" and test("^[A-Za-z0-9_-]{43,128}$"))
  and (
    .SUTRA_OIDC_PROVIDERS
    | fromjson
    | type == "array"
      and (length == 1 or length == 2)
      and ((.[0] | keys - [
        "authorizationEndpoint",
        "clientId",
        "clientSecret",
        "id",
        "issuer",
        "jwksUri",
        "tokenEndpoint"
      ]) | length) == 0
      and .[0].id == "zoho"
      and .[0].issuer == "https://accounts.zoho.in"
      and .[0].authorizationEndpoint == "https://accounts.zoho.in/oauth/v2/auth"
      and .[0].tokenEndpoint == "https://accounts.zoho.in/oauth/v2/token"
      and .[0].jwksUri == "https://accounts.zoho.in/oauth/v2/keys"
      and (.[0].clientId | type == "string" and length >= 8 and length <= 256)
      and (.[0].clientSecret | type == "string" and length >= 8 and length <= 512)
      and (
        length == 1
        or (
          ((.[1] | keys - [
            "authorizationEndpoint",
            "authorizationPrompt",
            "clientId",
            "clientSecret",
            "id",
            "issuer",
            "jwksUri",
            "tokenEndpoint"
          ]) | length) == 0
          and .[1].id == "google"
          and .[1].issuer == "https://accounts.google.com"
          and .[1].authorizationEndpoint == "https://accounts.google.com/o/oauth2/v2/auth"
          and .[1].tokenEndpoint == "https://oauth2.googleapis.com/token"
          and .[1].jwksUri == "https://www.googleapis.com/oauth2/v3/certs"
          and .[1].authorizationPrompt == "select_account"
          and (.[1].clientId
            | type == "string" and test("^[A-Za-z0-9._-]{4,200}\\.apps\\.googleusercontent\\.com$"))
          and (.[1].clientSecret | type == "string" and length >= 8 and length <= 512)
        )
      )
  )
  and (
    [
      .SUTRA_ZOHO_CLIENT_SECRET,
      .SUTRA_ZOHO_REFRESH_TOKEN,
      .SUTRA_OIDC_PROVIDERS,
      .SUTRA_OIDC_TRANSACTION_KEY
    ]
    | all(.[]; test("[\u0000-\u001f\u007f]") | not)
  )
' "$payload" >/dev/null || die "The Zoho runtime secret failed the exact configuration contract."

managed='^(SUTRA_CONTACT_FROM|SUTRA_CONTACT_PROVIDER|SUTRA_CONTACT_RECIPIENT|SUTRA_IDENTITY_MODE|SUTRA_INVITATION_EMAIL_PROVIDER|SUTRA_INVITATION_FROM|SUTRA_OIDC_PROVIDERS|SUTRA_OIDC_TRANSACTION_KEY|SUTRA_ZOHO_CLIENT_ID|SUTRA_ZOHO_CLIENT_SECRET|SUTRA_ZOHO_DATACENTER|SUTRA_ZOHO_MAIL_ACCOUNT_ID|SUTRA_ZOHO_REFRESH_TOKEN)='
awk -v managed="$managed" '$0 !~ managed { print }' "$RUNTIME_ENV" >"$merged"
jq -r '
  [
    "SUTRA_CONTACT_RECIPIENT",
    "SUTRA_CONTACT_FROM",
    "SUTRA_CONTACT_PROVIDER",
    "SUTRA_INVITATION_FROM",
    "SUTRA_INVITATION_EMAIL_PROVIDER",
    "SUTRA_ZOHO_DATACENTER",
    "SUTRA_ZOHO_MAIL_ACCOUNT_ID",
    "SUTRA_ZOHO_CLIENT_ID",
    "SUTRA_ZOHO_CLIENT_SECRET",
    "SUTRA_ZOHO_REFRESH_TOKEN",
    "SUTRA_IDENTITY_MODE",
    "SUTRA_OIDC_PROVIDERS",
    "SUTRA_OIDC_TRANSACTION_KEY"
  ][] as $name
  | "\($name)=\(.[$name])"
' "$payload" >>"$merged"
chmod 0600 "$merged"
mv "$merged" "$RUNTIME_ENV"

mode="$(jq -r '.SUTRA_IDENTITY_MODE' "$payload")"
log "Installed the validated Zoho runtime bundle with identity mode $mode."
