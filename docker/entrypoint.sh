#!/bin/sh
set -eu

mkdir -p /app/runtime /app/.sutra
SUTRA_LOCAL_CONFIG_PATH=/app/runtime/.dev.vars pnpm pilot:setup
exec pnpm start:pilot
