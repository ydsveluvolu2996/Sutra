# Claude Code repository instructions

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
- Do not merge, publish an image or deploy until all 27 in-scope dashboards and G7 release acceptance pass and the user explicitly authorizes deployment.

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
