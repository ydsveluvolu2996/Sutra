#!/usr/bin/env bash

set -euo pipefail

if [[ "${1:-}" == "--" ]]; then
  shift
fi

repository_root="$(git rev-parse --show-toplevel)"
[[ -n "${repository_root}" && -d "${repository_root}/.git" ]]
cd "${repository_root:?}"

if [[ "$(git branch --show-current)" != "develop" ]]; then
  echo "Daily checkpoints must be made from develop. Run 'pnpm work:start' first." >&2
  exit 1
fi

checkpoint_message="${*:-chore: daily development checkpoint $(date -u +%Y-%m-%dT%H:%MZ)}"
[[ -n "${checkpoint_message}" && "${#checkpoint_message}" -le 200 ]]
[[ "${checkpoint_message}" != *$'\n'* && "${checkpoint_message}" != *$'\r'* ]]

node scripts/check-repository-secrets.mjs
git add -A
git diff --cached --check

if ! git diff --cached --quiet; then
  git commit -m "${checkpoint_message}"
fi

git fetch origin develop

save_recovery_checkpoint() {
  local checkpoint_stamp checkpoint_sha recovery_branch
  checkpoint_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  checkpoint_sha="$(git rev-parse --short=12 HEAD)"
  recovery_branch="checkpoint/develop-${checkpoint_stamp}-${checkpoint_sha}"
  [[ "${recovery_branch}" =~ ^checkpoint/develop-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]]
  git push origin "HEAD:refs/heads/${recovery_branch}"
  echo "Develop changed remotely and could not be rebased automatically." >&2
  echo "Your checkpoint is safe on GitHub as ${recovery_branch}." >&2
}

if ! git merge-base --is-ancestor origin/develop HEAD; then
  if git merge-base --is-ancestor HEAD origin/develop; then
    git merge --ff-only origin/develop
  elif ! git rebase origin/develop; then
    git rebase --abort
    save_recovery_checkpoint
    exit 1
  fi
fi

if ! git push origin develop; then
  git fetch origin develop
  if ! git merge-base --is-ancestor origin/develop HEAD; then
    if ! git rebase origin/develop; then
      git rebase --abort
      save_recovery_checkpoint
      exit 1
    fi
  fi
  if ! git push origin develop; then
    save_recovery_checkpoint
    exit 1
  fi
fi

repository_name="ydsveluvolu2996/Sutra"
gh auth status >/dev/null
pull_requests="$(gh api \
  "repos/${repository_name}/pulls?state=open&base=main&head=ydsveluvolu2996:develop&per_page=100")"
pull_request_count="$(jq -r 'length' <<< "${pull_requests}")"
[[ "${pull_request_count}" =~ ^[0-9]+$ ]]

if [[ "${pull_request_count}" == "0" ]]; then
  created_pull_request="$(gh api \
    --method POST \
    "repos/${repository_name}/pulls" \
    -f title="develop → main" \
    -f head=develop \
    -f base=main \
    -f body=$'Standing integration pull request.\n\nEvery push to develop updates this PR and runs the complete CI gate. Merge only after the user explicitly says "commit to main".')"
  pull_requests="$(jq -c '[.]' <<< "${created_pull_request}")"
elif [[ "${pull_request_count}" != "1" ]]; then
  echo "Expected exactly one develop → main pull request; found ${pull_request_count}." >&2
  exit 1
fi

echo "Checkpoint saved to GitHub at $(git rev-parse --short=12 HEAD)."
jq -r '.[]? | "PR #\(.number): \(.html_url)"' <<< "${pull_requests}"
