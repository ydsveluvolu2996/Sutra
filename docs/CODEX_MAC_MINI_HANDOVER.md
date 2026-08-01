# Sutra FinOps — Codex Mac Mini handover

## Purpose

Continue the enterprise FinOps implementation on a Mac Mini using Codex only,
while the laptop is used only to review GitHub commits, test evidence and
tracker progress. Do not run Claude Code or a second code-writing Codex task
against the same checkout.

This handover publishes source code only. It does **not** authorize a production
deployment, image push, CloudFormation publication, AWS mutation or merge to
`main`.

## Current release snapshot

| Item | State at handover |
|---|---|
| Implementation base checkpoint | `8fb5919a24612e1ccf015110b040c45b5df59177`; use the latest remote head of `agent/enterprise-hardening-2` for the complete handover |
| Review | Draft PR #25; required GitHub checks must finish successfully |
| Public site | Healthy at `https://www.sutracmdb.com`, but serving an older immutable image |
| This checkpoint live? | **No**. A Git push is not a deployment |
| Production acceptance | **0 capabilities accepted**; controlled live evidence is still required |

The release workflows reject a feature-branch deployment. This checkpoint must
pass exact-SHA CI, receive independent approval, be merged to protected `main`,
pass the release-SHA CodeQL and environment gates, and then be deployed through
the reviewed immutable-image workflow. Do not weaken or bypass those controls.

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

### One command for a new Mac Mini checkout

After installing and signing in to Codex and GitHub CLI, run this once in
Terminal. It clones the exact handover branch, installs locked dependencies,
creates the continuation branch, and opens Codex with the execution prompt:

```bash
bash -lc 'set -euo pipefail; sutra_root=/Users/Shared/sutra-codex; mkdir -p "$sutra_root"; test ! -e "$sutra_root/Sutra"; git clone --branch agent/enterprise-hardening-2 --single-branch https://github.com/ydsveluvolu2996/Sutra.git "$sutra_root/Sutra"; exec bash "$sutra_root/Sutra/scripts/start-codex-mac-mini.sh"'
```

For an existing checkout, run:

```bash
bash /Users/Shared/sutra-codex/Sutra/scripts/start-codex-mac-mini.sh
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

For an overnight non-interactive run, save the execution prompt below as
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

## Complete capability tracker

Status meanings:

- **Local vertical**: authoritative input, tenant-scoped persistence, dynamic
  authenticated API, professional evidence-honest UI and focused tests exist in
  the repository. Live production acceptance is still pending.
- **Engine partial**: a bounded domain/source engine, contract and focused tests
  exist, but one or more of collection, persistence, API or UI is not yet a
  complete vertical slice.

### Foundational

| Capability | Local status | Remaining before production acceptance |
|---|---|---|
| CUDOS | Local vertical | Live CUR2 scale/reconciliation, two-tenant and rendered-browser acceptance |
| Cost Intelligence Dashboard | Local vertical | Live showback/forecast/commitment evidence and rendered-browser acceptance |
| KPI Dashboard | Local vertical | Live goal history, provider evidence, opportunity reconciliation and rendered acceptance |

### Advanced

| Capability | Local status | Remaining functional/UI work |
|---|---|---|
| Trusted Advisor Organizational | Engine partial | Durable collector/history, authenticated API, complete UI states and live Priority-plan acceptance |
| Compute Optimizer | Engine partial | Organization export/history persistence, API, UI and live acceptance |
| Cost Anomaly Detection | Local vertical | Live AWS collection, reconciliation, two-tenant and rendered acceptance |
| Extended Support Projection | Engine partial | Durable multi-service collection/history, API, UI and live lifecycle/cost acceptance |
| Graviton Savings | Engine partial | Compatibility evidence collection, persistence, API, UI and live savings validation |
| AWS Health Events | Engine partial | Organization event/entity persistence, API, UI and live entitlement/retention acceptance |
| AWS News Feeds | Engine partial | Governed scheduled persistence, authenticated API, usage-matched UI and live feed acceptance |
| AWS Budgets | Engine partial | Durable organization collection, API, separate provider UI and live actual/forecast acceptance |
| Support Cases Radar | Engine partial | Privacy-minimized collection/history, API, UI and live support-plan acceptance |
| ResilienceVue | Engine partial | Durable Resilience Hub assessments/drift, API, UI and live application acceptance |
| End User Computing | Engine partial | Durable WorkSpaces/AppStream collection, API, UI and live telemetry acceptance |
| Data Collection Monitor | Local vertical | Live failure/retry/latency/coverage reconciliation and rendered acceptance |
| Media Services Insights | Engine partial | Durable multi-service collection, API, UI and live telemetry/cost acceptance |

### Additional AWS capabilities

| Capability | Local status | Remaining functional/UI work |
|---|---|---|
| CORA | Engine partial | Durable COH/export collection, action ownership, API, UI and live reconciliation |
| FOCUS 1.2 | Local vertical | Live Data Export delivery, scale/reconciliation and rendered acceptance |
| Marketplace SPG | Engine partial | Durable agreements/licenses/grants collection, API, UI and live entitlement acceptance |
| Kubecost allocation | Engine partial | Exporter ingestion/persistence, API, UI and live workload reconciliation |
| SCAD allocation | Engine partial | Durable CUR2 split-cost lineage, API, UI and live allocation reconciliation |
| Sustainability and carbon | Engine partial | Durable provider export/API separation, UI and live carbon/proxy reconciliation |
| Trends | Local vertical | Live longitudinal scale, contributor reconciliation and rendered acceptance |
| Data Transfer | Local vertical | Live category/byte/cost reconciliation and rendered drilldown acceptance |
| Amazon Connect | Engine partial | Privacy-minimized durable collection, API, UI and live contact-cost acceptance |
| Config compliance | Engine partial | Aggregator/history/cost persistence, API, UI and live organization acceptance |
| Pricing Change Analysis | Engine partial | Version-pinned catalog persistence, API, UI and live repricing validation |

Current total: **8 local verticals, 19 engine-partial capabilities, 0
production-accepted**. A domain engine or documentation file is not a completed
dashboard.

## Application and release work still outside the 27 FinOps capabilities

| Area | Repository evidence | Remaining owner/live gate |
|---|---|---|
| Approval-only signup and tenant isolation | Implemented with scoped routes and adversarial tests | Repeat live two-client acceptance |
| AWS role onboarding | Versioned role templates and validation exist | Live quick-launch and least-privilege acceptance |
| Zoho invitations | Zoho delivery path exists | Production credential and invitation-acceptance test |
| SAML/OIDC/SCIM | Source and tenant-bound tests exist | Supply IdP metadata/certificate and run live SSO/SCIM acceptance |
| Professional navigation/UI | Enterprise UI and honest empty states exist | Full rendered navigation/icon/responsive/accessibility audit |
| Managed production release | Immutable image, migration, activation and rollback workflow exists | Protected-main merge, exact CodeQL, independent environment approval and controlled deployment |
| PostgreSQL/Docker integration | Local contracts and migrations exist | Run disposable PostgreSQL 16 and Docker gates on the Mac Mini |
| SES production delivery | Basic email path exists | AWS production-access approval and bounce/delay feedback acceptance |
| Signed outbound gateway | Contracts exist | Provision three distinct Ed25519 key pairs and complete live providers |

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
| 8 | Remaining Advanced and Additional capabilities | Continue only as complete provider→persistence→API→UI slices until all 27 rows are local verticals |

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

Use Codex only. Do not delegate to Claude Code and do not allow a second writer
to modify this checkout. Then complete every Engine partial row in the complete
capability tracker, following the prioritized queue one vertical slice at a time.
Every slice must include bounded authoritative collection, immutable
tenant/customer/connection-scoped persistence, authenticated API, professional
evidence-honest UI, adversarial isolation/integrity tests and local verification.
Use only official AWS sources for technical API/IAM facts. Do not add dummy data,
placeholder zeros, fabricated savings or fake success. Do not weaken tests.

For UI work, verify the real rendered route at desktop and narrow widths,
navigation and icon actions, loading/configuration-required/waiting/empty/
partial/stale/failed/complete states, keyboard access and the absence of fixture
or sandbox data. An engine without persistence, API and UI remains partial.

After a slice passes, commit only its files and push the continuation branch so
progress can be reviewed from the laptop. Never merge, deploy, publish an image,
modify production AWS, use customer credentials, or mark live acceptance passed.
Stop and report any gate failure or required owner/live action honestly. Once
all 27 rows are local verticals and all fixed-tree gates pass, prepare a final
release-readiness report and draft PR update. Do not deploy until an independent
reviewer and the protected release environment approve the exact main SHA.
```
