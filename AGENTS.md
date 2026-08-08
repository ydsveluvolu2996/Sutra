# Agent workflow

This file and `CLAUDE.md` state the same release and deployment policy. If they
ever disagree, `CLAUDE.md` is authoritative and this file is out of date; fix it
rather than following it.

## Release and deployment policy

Merging and deploying are separate decisions.

- Merging into `main` requires the user to have said "commit to main" (or
  equivalent) in that turn. Green checks are a precondition for merging, never
  an instruction to merge. Nothing else authorizes it: not finishing the work,
  not the user approving the work itself, not a reviewer signing off.
- Merging does not require deployment authorization. "Commit to main"
  authorizes the merge and nothing further.
- Deployment to https://www.sutracmdb.com happens only when the user says
  "deploy" in that turn. A merge is not a deploy instruction, an instruction
  from an earlier turn does not carry forward, and neither does a green
  pipeline.
- Merging to `main` never starts a release. `.github/workflows/ec2-live-release.yml`
  is manual-only so releases cannot accumulate, queue behind an old approval,
  or spend AWS compute merely because code was merged.
- When the user says "deploy", state the exact current `origin/main` SHA and run
  `pnpm deploy:ec2 -- "<approved reason>"`. The script requires successful CI
  for that SHA, dispatches the workflow on `main`, approves the
  `ec2-live-release` environment for that run only, waits for completion, and
  verifies that the completed run used the same SHA. Never dispatch or approve
  a different or older run.

## Branching and promotion

There is exactly one development branch: **`develop`**. All work goes there.
This overrides the "GitHub completion" section below, which assumed a pull
request by default.

- Commit and push new functionality to `develop`. Do not create a branch per
  change, per feature or per fix -- a second working branch is the thing this
  rule exists to prevent.
- Start a normal work session with `pnpm work:start`. It refuses to overwrite a
  dirty tree, switches to `develop`, and fast-forwards from GitHub.
- At the end of a task or day, after focused verification, run
  `pnpm work:save -- "<what changed>"`. It scans for committed credentials,
  checks the staged diff, commits all current work, rebases only unpublished
  local commits when necessary, pushes `develop`, and ensures the standing pull
  request exists. If a rebase conflicts, it aborts and pushes the intact commit
  to a timestamped `checkpoint/*` recovery branch instead of losing work.
- Keep exactly one standing pull request open, `develop` -> `main`, titled
  `develop → main`. It updates itself with every push, so no pull request is
  ever opened per change. If none is open, open one; never open a second.
- The standing pull request is not ceremony. CI triggers on `pull_request` and
  on `push` to `main`, and not on branch pushes, so without it `develop` would
  carry no verification at all and the first CI run would happen on `main` --
  where a green run is what fires a release. It is the only thing keeping
  unverified code off `main`.
- `develop` is only promoted to `main` when the user says "commit to main" (or
  equivalent). Merging is never implied by finishing work, by green checks, or
  by the user approving the work itself. Promotion merges the standing pull
  request; open a fresh one for the next cycle immediately afterwards.
- Promotion is a fast-forward or merge of `develop` into `main`, never a
  force-push and never a rewrite of `main`.
- Push only what local verification already covers: the relevant tests, `tsc`,
  `eslint` and the repository secret scan for the changed area.
- If a push turns `main` red, fixing it is the immediate next task. A red `main`
  blocks every later release, because the release run only fires on a successful
  CI run.

Promoting to `main` runs CI but does not start a release. "Commit to main"
authorizes the merge only. A later, current-turn "deploy" instruction authorizes
the exact-SHA manual release described above.

## Finish quickly

- Keep changes narrowly scoped to the requested outcome. Do not expand the task with unrelated cleanup.
- Run the smallest relevant test, typecheck, lint, or build set that gives confidence in the changed area. Run the full `pnpm verify` suite only when the change is broad, release-critical, or the user explicitly requests it.
- Prefer parallel execution for independent checks.
- If a check cannot run because an external service or credential is unavailable, report that specific gap; do not keep retrying unrelated alternatives.

## GitHub completion

- When the user asks to publish or complete work, carry the workflow through commit and push in the same task.
- Do not create a pull request unless the user asks for one; see the pull-request policy above. When one is asked for, create it ready for review. Use a draft only when the work is knowingly incomplete, checks are still running, or the user explicitly asks for a draft.
- Keep the PR description concise: outcome, risk, verification, and any remaining blocker.
- If the user explicitly asks to merge, verify that required checks and reviews pass, then merge immediately or enable auto-merge. A mergeable pull request left open because the user has not asked to merge is the expected state under the branching policy above, not something to explain away or resolve by merging.
- Never bypass branch protection, required review, security gates, or production approval controls for speed.

## Deployment completion

- When the user asks to deploy, continue through dispatch, the exact run's environment approval, build, release, EC2 update, and live verification; do not stop after creating a run. Report the deployed environment, release commit, run URL, and verification result.
- Do not treat a successful merge as authorization to deploy. Dispatch and approve only after an explicit current-turn deployment instruction. See the release and deployment policy above.
- Use focused pre-merge checks and let CI run the repository's required full gates. Do not duplicate an expensive full suite locally unless it materially reduces risk.
- Treat missing credentials, environment approvals, failed required checks, and absent deployment configuration as explicit blockers. Never bypass them or claim that source changes are deployed.
