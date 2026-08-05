#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

bash -n deploy/production/entrypoint.sh
bash -n deploy/production/bootstrap-ha.sh
node --check deploy/production/migrate.mjs
node --check services/notification-worker/production-entrypoint.mjs
ruby -e 'require "yaml"; Psych.parse_file(ARGV[0])' infrastructure/production-ha.yaml
ruby -e 'require "yaml"; Psych.parse_file(ARGV[0])' infrastructure/production-network.yaml
ruby -e 'require "yaml"; Psych.parse_file(ARGV[0])' infrastructure/production-ha-bootstrap-iam.yaml
ruby -e 'require "yaml"; Psych.parse_file(ARGV[0])' .github/workflows/production-ha-bootstrap.yml
ruby -e 'require "yaml"; Psych.parse_file(ARGV[0])' .github/workflows/production-ha-release.yml

if command -v cfn-lint >/dev/null 2>&1; then
  node scripts/cfn-lint.mjs infrastructure/production-network.yaml infrastructure/production-ha-bootstrap-iam.yaml infrastructure/production-ha.yaml
else
  printf '%s\n' "cfn-lint is unavailable; structural contract tests still run, but CI must run pinned cfn-lint."
fi

node --test tests/production-network-infrastructure.test.mjs tests/production-ha-bootstrap-iam.test.mjs tests/production-ha-infrastructure.test.mjs

if grep -Eq '^[[:space:]]+Type:[[:space:]]+AWS::EC2::Instance([[:space:]]|$)' infrastructure/production-ha.yaml; then
  printf '%s\n' "Managed production must not contain a single-host EC2 application server." >&2
  exit 1
fi

if grep -Eq 'Image:[[:space:]]+.*:(latest|main|production)([[:space:]]|$)' infrastructure/production-ha.yaml; then
  printf '%s\n' "Managed production contains a mutable container image." >&2
  exit 1
fi

printf '%s\n' "Managed production infrastructure validation passed."
