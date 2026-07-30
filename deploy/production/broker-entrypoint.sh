#!/bin/sh
# Start the stateless hosted broker. Durable connection, replay, and operation
# state lives in PostgreSQL; no task-local registry path is created.
set -eu

required_values="
SUTRA_DB_HOST
SUTRA_DB_PORT
SUTRA_DB_NAME
SUTRA_DB_APP_USER
SUTRA_DB_APP_PASSWORD
SUTRA_REGISTRY_ENCRYPTION_KEY
SUTRA_APP_PUBLIC_KEYS
SUTRA_BROKER_RESPONSE_KEY_ID
SUTRA_BROKER_RESPONSE_PRIVATE_KEY
SUTRA_COLLECTOR_PRINCIPAL_ARN
SUTRA_AGENTLESS_SCAN_ACCOUNT_ID
SUTRA_AGENTLESS_SCAN_AZ
SUTRA_AGENTLESS_KMS_KEY_ARN
SUTRA_AGENTLESS_SCANNER_IMAGE
SUTRA_AGENTLESS_LIVE_VALIDATED
SUTRA_AGENTLESS_LIVE_VALIDATION_APPROVAL
SUTRA_AGENTLESS_ORCHESTRATOR_ROLE_ARN
SUTRA_AGENTLESS_AMI_ID
SUTRA_AGENTLESS_INSTANCE_TYPE
SUTRA_AGENTLESS_SUBNET_ID
SUTRA_AGENTLESS_SECURITY_GROUP_ID
SUTRA_AGENTLESS_INSTANCE_PROFILE_ARN
SUTRA_AGENTLESS_FINDINGS_BUCKET
"

require_one_line() {
  name="$1"
  eval "value=\${$name:-}"
  [ -n "$value" ] || {
    printf 'Managed broker configuration is missing %s\n' "$name" >&2
    exit 1
  }
  case "$value" in
    *'
'*) printf 'Managed broker configuration %s contains a newline\n' "$name" >&2; exit 1 ;;
  esac
}

for name in $required_values; do
  require_one_line "$name"
done

DATABASE_URL="$(
  node -e '
    const url = new URL("postgresql://placeholder/");
    url.username = process.env.SUTRA_DB_APP_USER;
    url.password = process.env.SUTRA_DB_APP_PASSWORD;
    url.hostname = process.env.SUTRA_DB_HOST;
    url.port = process.env.SUTRA_DB_PORT;
    url.pathname = `/${process.env.SUTRA_DB_NAME}`;
    url.searchParams.set("sslmode", "require");
    process.stdout.write(url.toString());
  '
)"
export DATABASE_URL

exec node /app/services/aws-collector/dist/src/hosted-server.js
