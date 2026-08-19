#!/usr/bin/env bash
# Verify the browser-visible identity contract without following the provider
# redirect or printing OAuth client details, transaction cookies, or URLs.
set -Eeuo pipefail

log() { printf '[sutra:identity-check] %s\n' "$*"; }
die() { printf '[sutra:identity-check:error] %s\n' "$*" >&2; exit 1; }

PUBLIC_ORIGIN="${1:-https://www.sutracmdb.com}"
[[ "$PUBLIC_ORIGIN" =~ ^https://[a-z0-9.-]+$ ]] || die "A canonical HTTPS origin is required."

VERIFY_ROOT="$(mktemp -d)"
cleanup() {
  [[ -n "${VERIFY_ROOT:-}" && -d "$VERIFY_ROOT" ]] && rm -rf -- "$VERIFY_ROOT"
}
trap cleanup EXIT INT TERM

HEADERS=""
BODY=""
STATUS="000"
fetch_status() {
  local expected="$1" path="$2" label="$3" attempts="$4" attempt
  HEADERS="$VERIFY_ROOT/$label.headers"
  BODY="$VERIFY_ROOT/$label.body"
  STATUS="000"
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if STATUS="$(curl --silent --show-error \
      --connect-timeout 10 --max-time 15 --max-redirs 0 \
      --user-agent 'sutra-release-verifier/1 (+deploy/ec2/release-update.sh)' \
      --header 'X-Sutra-Release-Verifier: 1' \
      --dump-header "$HEADERS" --output "$BODY" \
      --write-out '%{http_code}' "$PUBLIC_ORIGIN$path")" \
      && [[ "$STATUS" == "$expected" ]]; then
      return 0
    fi
    (( attempt == attempts )) || sleep 5
  done
  die "$path did not return the expected HTTP $expected response (last status: $STATUS)."
}

fetch_status 200 "/api/auth/federation" "federation" 6
tr -d '\r' < "$HEADERS" | grep -Eiq '^cache-control:[[:space:]]*no-store([[:space:]]|$)' || \
  die "The public federation response is cacheable."
jq -e '
  .identityMode == "oidc"
  and .invitationOnly == false
  and (.providers | type == "array" and length == 2)
  and ([.providers[] | select(
    .id == "google"
    and .kind == "oidc"
    and .label == "Google"
    and .startUrl == "/api/auth/oidc/start?provider=google"
  )] | length == 1)
  and ([.providers[] | select(
    .id == "zoho"
    and .kind == "oidc"
    and .label == "Zoho SSO"
    and .startUrl == "/api/auth/oidc/start?provider=zoho"
  )] | length == 1)
' "$BODY" >/dev/null || \
  die "The public federation contract is not self-serve OIDC with exactly Google and Zoho."

fetch_status 302 "/api/auth/oidc/start?provider=google" "google-start" 3
tr -d '\r' < "$HEADERS" | grep -Eiq '^cache-control:[[:space:]]*no-store([[:space:]]|$)' || \
  die "The Google authorization response is cacheable."
cookie="$(tr -d '\r' < "$HEADERS" | awk '
  tolower($1) == "set-cookie:" && $0 ~ /sutra_oidc_transaction=/ { print; exit }
')"
[[ "$cookie" == *"; Path=/api/auth/oidc"* \
  && "$cookie" == *"; HttpOnly"* \
  && "$cookie" == *"; Secure"* \
  && "$cookie" == *"; SameSite=Lax"* \
  && "$cookie" == *"; Max-Age=300"* ]] || \
  die "The Google OIDC transaction cookie is missing its production security attributes."

location="$(tr -d '\r' < "$HEADERS" | awk '
  tolower($1) == "location:" {
    $1 = ""; sub(/^[[:space:]]+/, ""); print
  }
' | tail -n1)"
[[ "$location" == https://accounts.google.com/o/oauth2/v2/auth\?* ]] || \
  die "Google sign-in did not redirect to the pinned authorization endpoint."
query="${location#*\?}"
query_lines="$VERIFY_ROOT/google-query.txt"
tr '&' '\n' <<< "$query" > "$query_lines"
for required in \
  "response_type=code" \
  "redirect_uri=https%3A%2F%2Fwww.sutracmdb.com%2Fapi%2Fauth%2Foidc%2Fcallback" \
  "code_challenge_method=S256" \
  "prompt=select_account"; do
  grep -Fqx "$required" "$query_lines" || \
    die "Google sign-in is missing a required authorization parameter."
done
grep -Eq '^client_id=[A-Za-z0-9._-]{4,200}\.apps\.googleusercontent\.com$' "$query_lines" || \
  die "Google sign-in is missing the approved Web OAuth client identifier shape."
grep -Eq '^state=[A-Za-z0-9_-]{32,128}$' "$query_lines" || \
  die "Google sign-in is missing a bounded anti-forgery state value."
grep -Eq '^nonce=[A-Za-z0-9_-]{32,128}$' "$query_lines" || \
  die "Google sign-in is missing a bounded replay-protection nonce."
grep -Eq '^code_challenge=[A-Za-z0-9_-]{43,128}$' "$query_lines" || \
  die "Google sign-in is missing a bounded PKCE challenge."

log "Public self-serve Google and Zoho identity flow is ready."
