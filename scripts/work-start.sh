#!/usr/bin/env bash

set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
[[ -n "${repository_root}" && -d "${repository_root}/.git" ]]
cd "${repository_root:?}"

if [[ -n "$(git status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "The worktree has unsaved changes. Run 'pnpm work:save -- \"message\"' before syncing." >&2
  exit 1
fi

git fetch origin main develop

if [[ "$(git branch --show-current)" != "develop" ]]; then
  if git show-ref --verify --quiet refs/heads/develop; then
    git switch develop
  else
    git switch --track origin/develop
  fi
fi

if git merge-base --is-ancestor HEAD origin/develop; then
  git merge --ff-only origin/develop
elif ! git merge-base --is-ancestor origin/develop HEAD; then
  echo "Local develop and origin/develop have diverged. Save the local commits before resolving." >&2
  exit 1
fi

echo "Development workspace is ready at $(git rev-parse --short=12 HEAD)."
git status --short --branch
