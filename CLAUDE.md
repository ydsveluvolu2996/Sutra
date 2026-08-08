# Claude Code repository instructions

## Release and deployment policy

Merging and deploying are separate decisions. This policy governs both and
overrides the merge half of the release constraint in the anti-rework protocol
below.

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
- Merging to `main` never starts a release. `ec2-live-release.yml` is
  manual-only so releases cannot accumulate, queue behind an old approval, or
  spend AWS compute merely because code was merged.
- When the user says "deploy", state the exact current `origin/main` SHA and run
  `pnpm deploy:ec2 -- "<approved reason>"`. The script requires successful CI
  for that SHA, dispatches the workflow on `main`, approves the
  `ec2-live-release` environment for that run only, waits for completion, and
  verifies that the completed run used the same SHA. Never dispatch or approve
  a different or older run.

There is exactly one development branch: **`develop`**. All work goes there.

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
- If a push turns `main` red, fixing it is the immediate next task, ahead of
  whatever came next. A red `main` blocks every later release, because the
  release run only fires on a successful CI run.

Promoting to `main` runs CI but does not start a release. "Commit to main"
authorizes the merge only. A later, current-turn "deploy" instruction authorizes
the exact-SHA manual release described above.

## Mandatory read order

Before editing this repository, read these files completely in order:

1. `docs/CLAUDE_CODE_FINOPS_HANDOVER_2026-08-02.md`
2. `docs/FINOPS_CID_IMPLEMENTATION_TRACKER.md`
3. The matching `docs/finops-cid-evidence/<ID>-*.md` record for the dashboard being closed
4. `docs/FINOPS_VERTICAL_CLOSURE_TEMPLATE.md`

`agent/mac-mini-finops-continuation` and commit `4a2aa98` are the historical origin of this work, recorded so the handover documents can be read in context. They are no longer a precondition for editing: work happens on `develop` per the branching policy above, and that policy wins. Confirm only that `develop` is current and the worktree is clean before making changes.

## Non-negotiable anti-rework protocol

- Never rebuild a vertical from scratch. Inventory the existing UI, API, library, database, collector, IAM, tests and evidence first.
- Create a closure worksheet from `docs/FINOPS_VERTICAL_CLOSURE_TEMPLATE.md` before editing. Classify every existing asset as `REUSE_AS_IS`, `REPAIR`, `MISSING` or `UNAVAILABLE_BY_CONTRACT`.
- `REUSE_AS_IS` files are frozen unless a failing requirement or test proves a change is necessary. Record the reason before changing one.
- Close one vertical completely through G0-G6 before starting another. ADV-05 Graviton is first.
- Do not mix refactors, formatting sweeps, dependency upgrades or unrelated cleanup into a vertical closure.
- Preserve exact permission-pack and migration reservations from the handover. Never renumber work that already exists.
- Update evidence and tracker maturity only after the final feature SHA passes all required candidate gates.
- Commit and push the feature first; commit and push evidence/tracker changes second. Never force-push or rewrite handoff history.
- ADD-02 Azure and ADD-03 GCP remain excluded from the 27-dashboard release.
- Do not publish an image or deploy until all 27 in-scope dashboards and G7 release acceptance pass and the user explicitly authorizes deployment. Merging is governed by the release and deployment policy at the top of this file: green pull requests merge into `main` without deployment authorization.

## Parallel-agent ownership rule

Parallel agents may audit or implement only disjoint vertical-specific files. One designated integrator exclusively owns all shared files:

- `package.json`, `pnpm-lock.yaml` and workspace dependency manifests
- `services/aws-collector/src/role-broker.ts`
- `services/aws-collector/src/local-server.ts`
- `lib/finops-daily.ts`
- `db/runtime-migrations.ts`
- `db/postgres-runtime-migrations.ts`
- `scripts/postgres-migrate.mjs`
- `infrastructure/customer-onboarding-role-standard-2026-08.*.yaml`
- central permission catalogs/allowlists and CloudFormation lint inputs
- `docs/FINOPS_CID_IMPLEMENTATION_TRACKER.md`
- `docs/CLAUDE_CODE_FINOPS_HANDOVER_2026-08-02.md`

Permission successors `.8.12` through `.8.19` must be integrated sequentially by that same integrator. An agent must not edit a shared file, start a successor pack or promote a tracker row independently.

## Truth and safety boundaries

- `LOCAL_VERTICAL_CANDIDATE` is locally complete, not production-ready or live-accepted.
- Missing provider evidence is unavailable/collecting/failed, never zero or healthy by assumption.
- AWS credentials remain collector-owned; preserve tenant, account, connection, request, deadline and signature binding.
- Monetary values retain exact micros, currency separation and lineage.
- Older permission templates are immutable. Successors use exact enumerated allowlists, never lexical comparisons or permissive regexes.
- A SQL migration is incomplete until registered in all three migration registries and proven on SQLite and PostgreSQL.
- Use Node `v22.23.2` for authoritative verification.

If any instruction, reservation or ownership boundary conflicts with the repository state, stop and document the conflict instead of guessing.
