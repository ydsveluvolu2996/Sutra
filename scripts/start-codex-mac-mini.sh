#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
handover_branch="agent/enterprise-hardening-2"
continuation_branch="agent/mac-mini-finops-continuation"
handover_file="${repo_dir}/docs/CODEX_MAC_MINI_HANDOVER.md"

for command_name in git node corepack codex gh; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "Required command is unavailable: ${command_name}" >&2
    exit 1
  }
done

cd "${repo_dir}"
test -f "${handover_file}"
test -z "$(git status --porcelain)" || {
  echo "The Sutra checkout is not clean. Review or commit those changes before continuing." >&2
  exit 1
}

gh auth status >/dev/null
git fetch origin "${handover_branch}" "${continuation_branch}" 2>/dev/null || \
  git fetch origin "${handover_branch}"

if git show-ref --verify --quiet "refs/heads/${continuation_branch}"; then
  git switch "${continuation_branch}"
  if git show-ref --verify --quiet "refs/remotes/origin/${continuation_branch}"; then
    git pull --ff-only origin "${continuation_branch}"
  fi
else
  git switch -c "${continuation_branch}" "origin/${handover_branch}"
fi

git merge-base --is-ancestor "origin/${handover_branch}" HEAD || {
  echo "The continuation branch does not contain the published handover checkpoint." >&2
  exit 1
}
test -z "$(git status --porcelain)"

corepack enable
corepack prepare pnpm@11.13.1 --activate
pnpm install --frozen-lockfile

execution_prompt="$(sed -n '/^## Execution prompt for Codex$/,$p' "${handover_file}" | sed '1,/^```text$/d; /^```$/,$d')"
test -n "${execution_prompt}"

exec codex \
  -C "${repo_dir}" \
  -m gpt-5.6-sol \
  -c 'model_reasoning_effort="high"' \
  -s workspace-write \
  -a on-request \
  --search \
  "${execution_prompt}"
