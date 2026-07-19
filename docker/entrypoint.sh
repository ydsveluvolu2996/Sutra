#!/bin/sh
set -eu

mkdir -p /app/runtime /app/.sutra
SUTRA_LOCAL_CONFIG_PATH=/app/runtime/.dev.vars node scripts/setup-local-pilot.mjs
exec node scripts/start-pilot.mjs
