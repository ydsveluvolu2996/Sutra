# Sutra FinOps — Codex Mac Mini handover

## Purpose

Continue the enterprise FinOps implementation on a Mac Mini using Codex only,
while the laptop is used to review GitHub commits, test evidence and tracker
progress.

This handover publishes source code only. It does **not** authorize a production
deployment, image push, CloudFormation publication, AWS mutation or merge to
`main`.

## Authoritative Git source

- Repository: `https://github.com/ydsveluvolu2996/Sutra.git`
- Handover branch: `agent/enterprise-hardening-2`
- Previous stable checkpoint: `9eaa3c8110094ab31c75ab3b8c1f9d866f62bf93`
- Required Node.js: `>=22.13.0`
- Required package manager: `pnpm@11.13.1`

Always verify the current remote head on the Mac Mini rather than copying a
working directory from another computer.

## Mac Mini setup

```bash
mkdir -p /Users/Shared/sutra-codex
cd /Users/Shared/sutra-codex
git clone https://github.com/ydsveluvolu2996/Sutra.git
cd Sutra
git fetch origin
git switch --track origin/agent/enterprise-hardening-2
git status --short
git rev-parse HEAD
corepack enable
corepack prepare pnpm@11.13.1 --activate
pnpm install --frozen-lockfile
```

`git status --short` must be empty before Codex starts.

Create a continuation branch so the handover branch remains reviewable:

```bash
git switch -c agent/mac-mini-finops-continuation
```

## Start Codex

Recommended model: `gpt-5.6-sol` with high reasoning effort.

Interactive:

```bash
codex \
  -C /Users/Shared/sutra-codex/Sutra \
  -m gpt-5.6-sol \
  -c 'model_reasoning_effort="high"' \
  -s workspace-write \
  -a never \
  --search
```

Paste the execution prompt at the end of this document into Codex.

For an overnight non-interactive run, save that prompt as
`/Users/Shared/sutra-codex/MAC_MINI_PROMPT.md`, then run:

```bash
codex exec \
  -C /Users/Shared/sutra-codex/Sutra \
  -m gpt-5.6-sol \
  -c 'model_reasoning_effort="high"' \
  -s workspace-write \
  -a never \
  --search \
  "$(cat /Users/Shared/sutra-codex/MAC_MINI_PROMPT.md)" \
  | tee /Users/Shared/sutra-codex/CODEX_RUN_LOG.txt
```

Do not use `--dangerously-bypass-approvals-and-sandbox`.

## What is implemented in the handover candidate

1. Canonical CUR2 and FOCUS parsing, immutable billing generations and active
   evidence.
2. Server-owned Data Export observation outbox. The browser supplies only
   `{connectionId, observationId}`; signed manifest identity and reconciliation
   evidence are loaded from immutable tenant-scoped storage.
3. Durable CUR2/FOCUS ingestion with deterministic queue idempotency, exact
   contract-to-table validation and collision-safe FOCUS row identities.
4. Retained rotating customer-managed KMS keys for new CUR2/FOCUS export
   buckets, exact SSE-KMS encryption, exact-key collector decrypt and attested
   existing-bucket CMKs.
5. AWS Cost Anomaly Detection collection, minimized immutable evidence,
   authenticated GET/POST API and a professional AWS-specific Budgets panel
   kept separate from Sutra statistical alerts.
6. CUDOS, Cost Intelligence, KPI, Data Collection Monitor, Trends and Data
   Transfer authenticated API/UI paths.
7. Tenant-scoped source ledger/snapshot runtime and evidence-honest source
   states.

None of these capabilities is production-accepted until controlled live AWS,
two-tenant, rendered UI and release gates pass.

## Mandatory first gate on the Mac Mini

Before implementing another capability, run from one fixed tree:

```bash
pnpm typecheck
pnpm typecheck:collector
pnpm lint
pnpm security:secrets
git diff --check
pnpm build
pnpm test:rendered
node scripts/ci-test-shard.mjs --shard 1/6
node scripts/ci-test-shard.mjs --shard 2/6
node scripts/ci-test-shard.mjs --shard 3/6
node scripts/ci-test-shard.mjs --shard 4/6
node scripts/ci-test-shard.mjs --shard 5/6
node scripts/ci-test-shard.mjs --shard 6/6
```

If Docker Desktop is available, also run the repository's disposable
PostgreSQL 16 migration/runtime-role tests. Never point tests at production or
the live application database.

Record exact pass/fail/skip counts in `MAC_MINI_PROGRESS.md`. A skipped gate is
not a pass.

## Prioritized implementation queue

Work on one complete vertical slice at a time:

| Order | Capability | Required end-to-end outcome |
|---|---|---|
| 1 | Trusted Advisor Organizational | Bounded collector, immutable tenant report, authenticated API, professional panel, Priority-vs-standard limitation and adversarial tests |
| 2 | Pricing Change Analysis | Pinned AWS Price List evidence, immutable report, authenticated API, professional panel, exact signed repricing and adversarial tests |
| 3 | Compute Optimizer Organization | Organization export/history collector, persistence, API/UI and live-ready states |
| 4 | AWS Health Organization | Account/event/entity coverage, persistence, API/UI and entitlement/retention states |
| 5 | AWS Budgets Organization | Real AWS budgets, actual/forecast hierarchy, persistence and UI kept separate from Sutra budgets |
| 6 | Support Cases Radar | Privacy-minimized account fan-out, persistence/API/UI and support-plan states |
| 7 | ResilienceVue | Resilience Hub applications, assessments, drift and recommendations with evidence-bound claims |
| 8 | Remaining Advanced and Additional capabilities | Continue only as complete provider→persistence→API→UI slices |

Do not create a generic dashboard row and call it a completed capability.

## Definition of done for every capability

- Server-approved, bounded authoritative source operations.
- Read-only permanent collector; provisioning/actions remain separate roles.
- Immutable org/customer/connection-scoped persistence.
- Partial or failed attempts never replace the last accepted complete report.
- Dynamic authenticated API deriving tenant/customer scope server-side.
- Professional loading, waiting, empty, configuration-required, partial, stale,
  failed and complete UI states.
- No dummy values, fixtures, placeholder zeros or fabricated savings.
- Cross-tenant, replay, substitution, pagination, schema, timestamp and evidence
  integrity negative tests.
- Root and collector typechecks, lint, secret scan, build and focused tests.
- Controlled live acceptance remains explicitly pending until actually run.

## Git progress workflow

After each complete, locally green vertical slice:

```bash
git status --short
git diff --check
git add <only-the-capability-files>
git commit -m "Complete <capability> vertical slice"
git push -u origin agent/mac-mini-finops-continuation
```

Use the same continuation branch and draft PR for progress visibility. Do not
merge, rebase the published handover branch, force-push, tag a release, publish
an image or deploy.

Each pushed checkpoint must update `MAC_MINI_PROGRESS.md` with:

- capability and status;
- exact changed files;
- exact test commands and pass/fail/skip counts;
- unavailable local gates;
- live AWS/owner actions still required;
- next bounded slice.

## Execution prompt for Codex

```text
Continue Sutra enterprise FinOps from docs/CODEX_MAC_MINI_HANDOVER.md.

Read the handover and repository instructions completely. First verify that the
current branch is agent/mac-mini-finops-continuation, the working tree is clean,
and its parent is the published agent/enterprise-hardening-2 handover. Run the
mandatory fixed-tree gate before implementing new functionality. Record exact
results in MAC_MINI_PROGRESS.md.

Then complete the prioritized capability queue one vertical slice at a time.
Every slice must include bounded authoritative collection, immutable
tenant/customer/connection-scoped persistence, authenticated API, professional
evidence-honest UI, adversarial isolation/integrity tests and local verification.
Use only official AWS sources for technical API/IAM facts. Do not add dummy data,
placeholder zeros, fabricated savings or fake success. Do not weaken tests.

After a slice passes, commit only its files and push the continuation branch so
progress can be reviewed from the laptop. Never merge, deploy, publish an image,
modify production AWS, use customer credentials, or mark live acceptance passed.
Stop and report any gate failure or required owner/live action honestly.
```
