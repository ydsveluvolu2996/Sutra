# Agent workflow

This file and `CLAUDE.md` state the same release and deployment policy. If they
ever disagree, `CLAUDE.md` is authoritative and this file is out of date; fix it
rather than following it.

## Release and deployment policy

Merging and deploying are separate decisions.

- Merge a pull request into `main` as soon as its required checks are green. No
  deployment authorization is needed to merge.
- Never approve a release run. Deployment to https://www.sutracmdb.com happens
  only when the user says "deploy" in that turn. A merge is not a deploy
  instruction, an approval given for an earlier release does not carry forward,
  and neither does a green pipeline.
- Every merge to `main` automatically fires `.github/workflows/ec2-live-release.yml`,
  which parks on the `ec2-live-release` environment approval. Parked runs are
  expected to accumulate; leave them parked.
- Each parked run is pinned to the SHA it was created from. When the user says
  "deploy", approve the newest parked run, or dispatch a fresh one at current
  `main` if the newest parked run is not the current head. Never approve an
  older parked run -- doing so deploys superseded code over newer code. State
  which SHA is going live before approving.
- Parked runs expire after 30 days. After a long gap, dispatch fresh rather than
  approving a stale run.

## When a pull request is required

Do not open a pull request unless the user asks for one. The round trip costs
more time than it returns on work the user is waiting on. This overrides the
"GitHub completion" section below, which assumed a pull request by default.

- Commit and push completed work directly to `main`. No branch, no pull
  request, no waiting to be told to merge.
- Open a pull request only when the user says to, or when the change cannot be
  verified locally and needs CI to prove it.
- Push only what local verification already covers: the relevant tests, `tsc`,
  `eslint` and the repository secret scan for the changed area. CI on `main` is
  then a confirmation, not the first time the change is checked.
- If a direct push does turn `main` red, fixing it is the immediate next task.
  A red `main` blocks every later release, because the release run only fires
  on a successful CI run.

## Finish quickly

- Keep changes narrowly scoped to the requested outcome. Do not expand the task with unrelated cleanup.
- Run the smallest relevant test, typecheck, lint, or build set that gives confidence in the changed area. Run the full `pnpm verify` suite only when the change is broad, release-critical, or the user explicitly requests it.
- Prefer parallel execution for independent checks.
- If a check cannot run because an external service or credential is unavailable, report that specific gap; do not keep retrying unrelated alternatives.

## GitHub completion

- When the user asks to publish or complete work, carry the workflow through commit and push in the same task.
- Do not create a pull request unless the user asks for one; see the pull-request policy above. When one is asked for, create it ready for review. Use a draft only when the work is knowingly incomplete, checks are still running, or the user explicitly asks for a draft.
- Keep the PR description concise: outcome, risk, verification, and any remaining blocker.
- If the user explicitly asks to merge, verify that required checks and reviews pass, then merge immediately or enable auto-merge. Do not leave a mergeable PR waiting without explaining why.
- Never bypass branch protection, required review, security gates, or production approval controls for speed.

## Deployment completion

- When the user asks to deploy, continue through the repository's existing build, release, and deployment workflow; do not stop after creating or merging a PR. Report the deployed environment, release commit, and verification result.
- Do not treat a successful merge as authorization to deploy. The release run fires automatically and then waits; approving it is a separate act that requires the user to have asked for a deployment. See the release and deployment policy above.
- Use focused pre-merge checks and let CI run the repository's required full gates. Do not duplicate an expensive full suite locally unless it materially reduces risk.
- Treat missing credentials, environment approvals, failed required checks, and absent deployment configuration as explicit blockers. Never bypass them or claim that source changes are deployed.
