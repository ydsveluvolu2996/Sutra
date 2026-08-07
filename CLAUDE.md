# Claude Code repository instructions

## Release and deployment policy

Merging and deploying are separate decisions. This policy governs both and
overrides the merge half of the release constraint in the anti-rework protocol
below.

- Merge a pull request into `main` as soon as its required checks are green.
  No deployment authorization is needed to merge.
- Never approve a release run. Deployment to https://www.sutracmdb.com happens
  only when the user says "deploy" in that turn. A merge is not a deploy
  instruction, an approval given for an earlier release does not carry forward,
  and neither does a green pipeline.
- Every merge to `main` automatically fires `ec2-live-release.yml`, which parks
  on the `ec2-live-release` environment approval. Parked runs are expected to
  accumulate; leave them parked.
- Each parked run is pinned to the SHA it was created from. When the user says
  "deploy", approve the newest parked run, or dispatch a fresh one at current
  `main` if the newest parked run is not the current head. Never approve an
  older parked run -- doing so deploys superseded code over newer code.
  State which SHA is going live before approving.
- Parked runs expire after 30 days. After a long gap, dispatch fresh rather
  than approving a stale run.
- Superseded parked runs are left to expire. Do not approve them to clear the
  queue.

There is exactly one development branch: **`develop`**. All work goes there.

- Commit and push new functionality to `develop`. Do not create a branch per
  change, per feature or per fix -- a second working branch is the thing this
  rule exists to prevent.
- Do not open a pull request unless the user asks for one. The round trip costs
  more time than it returns on work the user is waiting on.
- `develop` is only promoted to `main` when the user says "commit to main" (or
  equivalent). Merging is never implied by finishing work, by green checks, or
  by the user approving the work itself.
- Promotion is a fast-forward or merge of `develop` into `main`, never a
  force-push and never a rewrite of `main`.
- Push only what local verification already covers: the relevant tests, `tsc`,
  `eslint` and the repository secret scan for the changed area.
- If a push turns `main` red, fixing it is the immediate next task, ahead of
  whatever came next. A red `main` blocks every later release, because the
  release run only fires on a successful CI run.

Promoting to `main` fires a release run, which then waits for the
`ec2-live-release` environment approval. That approval is the deployment
permission prompt: it is answered by the user, never by an agent. "Commit to
main" authorizes the merge, not the deployment.

## Mandatory read order

Before editing this repository, read these files completely in order:

1. `docs/CLAUDE_CODE_FINOPS_HANDOVER_2026-08-02.md`
2. `docs/FINOPS_CID_IMPLEMENTATION_TRACKER.md`
3. The matching `docs/finops-cid-evidence/<ID>-*.md` record for the dashboard being closed
4. `docs/FINOPS_VERTICAL_CLOSURE_TEMPLATE.md`

The active continuation branch is `agent/mac-mini-finops-continuation`. Confirm the branch is current, the worktree is clean, and commit `4a2aa98` is an ancestor before making changes.

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
