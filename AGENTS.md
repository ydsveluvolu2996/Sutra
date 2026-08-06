# Agent workflow

## Finish quickly

- Keep changes narrowly scoped to the requested outcome. Do not expand the task with unrelated cleanup.
- Run the smallest relevant test, typecheck, lint, or build set that gives confidence in the changed area. Run the full `pnpm verify` suite only when the change is broad, release-critical, or the user explicitly requests it.
- Prefer parallel execution for independent checks.
- If a check cannot run because an external service or credential is unavailable, report that specific gap; do not keep retrying unrelated alternatives.

## GitHub completion

- When the user asks to publish or complete work, carry the workflow through commit, push, and pull-request creation in the same task.
- Create a ready-for-review pull request by default. Use a draft only when the work is knowingly incomplete, checks are still running, or the user explicitly asks for a draft.
- Keep the PR description concise: outcome, risk, verification, and any remaining blocker.
- If the user explicitly asks to merge, verify that required checks and reviews pass, then merge immediately or enable auto-merge. Do not leave a mergeable PR waiting without explaining why.
- Never bypass branch protection, required review, security gates, or production approval controls for speed.

## Deployment completion

- When the user asks to deploy, continue through the repository's existing build, release, and deployment workflow; do not stop after creating or merging a PR.
- Prefer automated deployment triggered by a successful merge. Report the deployed environment, release commit, and verification result.
- Use focused pre-merge checks and let CI run the repository's required full gates. Do not duplicate an expensive full suite locally unless it materially reduces risk.
- Treat missing credentials, environment approvals, failed required checks, and absent deployment configuration as explicit blockers. Never bypass them or claim that source changes are deployed.
