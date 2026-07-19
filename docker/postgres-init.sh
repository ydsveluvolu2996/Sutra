#!/bin/sh
set -eu

test -n "${SUTRA_POSTGRES_APP_PASSWORD:-}"
psql --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set app_password="$SUTRA_POSTGRES_APP_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE sutra_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sutra_app')\gexec
ALTER ROLE sutra_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT LOGIN;
SQL
