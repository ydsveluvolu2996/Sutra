#!/usr/bin/env bash

set -euo pipefail

if [[ "${1:-}" == "--" ]]; then
  shift
fi

release_reason="${*:-}"
if [[ "${#release_reason}" -lt 10 || "${#release_reason}" -gt 100 ]]; then
  echo "Usage: pnpm deploy:ec2 -- \"approved release reason (10-100 characters)\"" >&2
  exit 1
fi
[[ "${release_reason}" != *$'\n'* && "${release_reason}" != *$'\r'* ]]

repository_root="$(git rev-parse --show-toplevel)"
[[ -n "${repository_root}" && -d "${repository_root}/.git" ]]
cd "${repository_root:?}"

repository_name="ydsveluvolu2996/Sutra"
origin_url="$(git remote get-url origin)"
[[ "${origin_url}" == "https://github.com/${repository_name}.git" \
  || "${origin_url}" == "git@github.com:${repository_name}.git" ]]
gh auth status >/dev/null

git fetch origin main
release_sha="$(git rev-parse origin/main)"
remote_sha="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
[[ "${release_sha}" =~ ^[a-f0-9]{40}$ ]]
[[ "${remote_sha}" == "${release_sha}" ]]

ci_runs="$(gh api \
  "repos/${repository_name}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=100")"
if ! jq -e --arg release_sha "${release_sha}" \
  '.workflow_runs | any(.head_sha == $release_sha and .conclusion == "success")' \
  <<< "${ci_runs}" >/dev/null; then
  echo "Current main ${release_sha} has no successful completed CI run; deployment is blocked." >&2
  exit 1
fi

existing_run_ids="$(gh api \
  "repos/${repository_name}/actions/workflows/ec2-live-release.yml/runs?event=workflow_dispatch&branch=main&per_page=100" \
  --jq '[.workflow_runs[].id]')"
[[ "$(jq -r 'type' <<< "${existing_run_ids}")" == "array" ]]
dispatch_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Dispatching EC2 release for main ${release_sha}."
gh workflow run ec2-live-release.yml \
  --repo "${repository_name}" \
  --ref main \
  -f "releaseReason=${release_reason}"

run_id=""
for _ in $(seq 1 60); do
  runs="$(gh api \
    "repos/${repository_name}/actions/workflows/ec2-live-release.yml/runs?event=workflow_dispatch&branch=main&per_page=20")"
  run_id="$(jq -r \
    --arg release_sha "${release_sha}" \
    --arg dispatch_started "${dispatch_started}" \
    --argjson existing_run_ids "${existing_run_ids}" \
    '[.workflow_runs[] | .id as $id | select(
      .head_sha == $release_sha
      and .created_at >= $dispatch_started
      and ($existing_run_ids | index($id) == null)
    )] | sort_by(.created_at) | first | .id // empty' \
    <<< "${runs}")"
  if [[ "${run_id}" =~ ^[0-9]+$ ]]; then
    break
  fi
  sleep 5
done

if [[ ! "${run_id}" =~ ^[0-9]+$ ]]; then
  echo "The workflow was dispatched, but its run ID could not be resolved." >&2
  exit 1
fi

echo "Release run: https://github.com/${repository_name}/actions/runs/${run_id}"

approved="false"
for _ in $(seq 1 120); do
  pending="$(gh api "repos/${repository_name}/actions/runs/${run_id}/pending_deployments")"
  environment_id="$(jq -r \
    '.[] | select(.environment.name == "ec2-live-release") | .environment.id' \
    <<< "${pending}" | head -n 1)"
  if [[ "${environment_id}" =~ ^[0-9]+$ ]]; then
    jq -n \
      --argjson environment_id "${environment_id}" \
      --arg comment "Approved by the explicit deploy instruction for ${release_sha}." \
      '{environment_ids: [$environment_id], state: "approved", comment: $comment}' |
      gh api \
        --method POST \
        "repos/${repository_name}/actions/runs/${run_id}/pending_deployments" \
        --input - >/dev/null
    approved="true"
    break
  fi

  run_status="$(gh api "repos/${repository_name}/actions/runs/${run_id}" --jq .status)"
  if [[ "${run_status}" == "in_progress" || "${run_status}" == "completed" ]]; then
    break
  fi
  sleep 5
done

if [[ "${approved}" == "true" ]]; then
  echo "Approved the ec2-live-release environment for this exact run."
fi

gh run watch "${run_id}" --repo "${repository_name}" --exit-status

completed_sha="$(gh run view "${run_id}" --repo "${repository_name}" --json headSha --jq .headSha)"
[[ "${completed_sha}" == "${release_sha}" ]]
echo "EC2 deployment completed successfully for ${release_sha}."
