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
# `main` is fetched too, so the standing-pull-request step below can tell
# "nothing to open one against yet" apart from a real API failure.
git fetch origin main

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

# The work is already pushed by this point. What follows only ensures the
# standing pull request exists -- but that is not cosmetic: CI triggers on
# `pull_request` and on push to `main`, never on a branch push, so without an
# open develop → main pull request the pushed commits carry no verification at
# all and the first CI run would happen on `main`, where a green run is what
# gates a release.
#
# This used to call `gh` unconditionally. On a machine without the GitHub CLI
# the script pushed successfully and then died at `gh auth status`, which read
# as a generic script error rather than "your CI safety net is missing" -- the
# push looked done and the pull request silently never appeared. So the CLI is
# now one of two transports, and the absence of both is reported for what it
# actually costs.
github_token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
api_transport=""

command -v jq >/dev/null 2>&1 || {
  echo "jq is required to manage the standing pull request." >&2
  exit 1
}

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  api_transport="gh"
elif [[ -n "${github_token}" ]] && command -v curl >/dev/null 2>&1; then
  # Token characters are validated because the value is interpolated into a
  # curl config below, where an embedded quote would break header framing.
  # GitHub tokens are drawn from this alphabet, so a rejection here means a
  # malformed value rather than a legitimate token being refused.
  if [[ "${github_token}" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    api_transport="curl"
  else
    echo "GH_TOKEN/GITHUB_TOKEN contains unexpected characters and was not used." >&2
  fi
fi

if [[ -z "${api_transport}" ]]; then
  echo "Your work is pushed, but the standing develop → main pull request could not be checked." >&2
  echo "Without it, develop runs no CI at all and the first CI run happens on main." >&2
  echo "Authenticate the GitHub CLI ('gh auth login') or export GH_TOKEN, then re-run 'pnpm work:save'." >&2
  exit 1
fi

# Both transports speak the same REST API and return the same JSON, so the pull
# request logic below is written once. The token is fed to curl through a config
# on stdin rather than an argument: a command line is world-readable in `ps`,
# and a credential does not belong there.
github_api() {
  local method="$1" path="$2" body_file="${3:-}"
  if [[ "${api_transport}" == "gh" ]]; then
    if [[ -n "${body_file}" ]]; then
      gh api --method "${method}" "${path}" --input "${body_file}"
    else
      gh api --method "${method}" "${path}"
    fi
    return
  fi

  local response status body
  response="$(
    {
      printf 'url = "https://api.github.com/%s"\n' "${path}"
      printf 'request = "%s"\n' "${method}"
      printf 'header = "Authorization: Bearer %s"\n' "${github_token}"
      printf 'header = "Accept: application/vnd.github+json"\n'
      printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
      printf 'silent\nshow-error\n'
      printf 'write-out = "\\n%%{http_code}"\n'
      if [[ -n "${body_file}" ]]; then
        printf 'header = "Content-Type: application/json"\n'
        printf 'data-binary = "@%s"\n' "${body_file}"
      fi
    } | curl --config -
  )"
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  if [[ ! "${status}" =~ ^2[0-9][0-9]$ ]]; then
    echo "GitHub API ${method} ${path} failed with HTTP ${status}." >&2
    jq -r '.message? // empty' <<< "${body}" >&2 || true
    return 1
  fi
  printf '%s' "${body}"
}

pull_requests="$(github_api GET \
  "repos/${repository_name}/pulls?state=open&base=main&head=ydsveluvolu2996:develop&per_page=100")"
pull_request_count="$(jq -r 'length' <<< "${pull_requests}")"
[[ "${pull_request_count}" =~ ^[0-9]+$ ]]

# Right after a promotion, develop and main are identical. GitHub refuses to
# open a pull request with no commit difference, so attempting one here fails
# with a bare 422 that reads like a broken script. There is genuinely nothing to
# open yet, and nothing unverified either -- the branch holds no work. The
# standing pull request is created by the next run, which pushes a real commit
# before reaching this point, so the first change of a cycle is never the thing
# that lands without a gate.
commits_ahead_of_main="$(git rev-list --count origin/main..HEAD)"
[[ "${commits_ahead_of_main}" =~ ^[0-9]+$ ]]

if [[ "${pull_request_count}" == "0" && "${commits_ahead_of_main}" == "0" ]]; then
  echo "Checkpoint saved to GitHub at $(git rev-parse --short=12 HEAD)."
  echo "develop matches main, so there is no standing pull request to open yet." >&2
  echo "It is opened automatically with the first change of this cycle." >&2
  exit 0
fi

if [[ "${pull_request_count}" == "0" ]]; then
  payload_file="$(mktemp)"
  trap 'rm -f "${payload_file}"' EXIT
  jq -n \
    --arg title "develop → main" \
    --arg head "develop" \
    --arg base "main" \
    --arg body $'Standing integration pull request.\n\nEvery push to develop updates this PR and runs the complete CI gate. Merge only after the user explicitly says "commit to main".' \
    '{title: $title, head: $head, base: $base, body: $body}' > "${payload_file}"
  created_pull_request="$(github_api POST "repos/${repository_name}/pulls" "${payload_file}")"
  pull_requests="$(jq -c '[.]' <<< "${created_pull_request}")"
elif [[ "${pull_request_count}" != "1" ]]; then
  echo "Expected exactly one develop → main pull request; found ${pull_request_count}." >&2
  exit 1
fi

echo "Checkpoint saved to GitHub at $(git rev-parse --short=12 HEAD)."
jq -r '.[]? | "PR #\(.number): \(.html_url)"' <<< "${pull_requests}"
