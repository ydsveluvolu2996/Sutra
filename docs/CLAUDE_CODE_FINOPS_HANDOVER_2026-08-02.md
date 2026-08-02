# Claude Code FinOps handover — 2026-08-02

This document is the continuation contract for the Sutra Cloud Intelligence / FinOps dashboard work.
It is deliberately conservative: a dashboard is not promoted merely because isolated engine or UI code exists.

## Repository and immutable handoff point

| Item | Value |
|---|---|
| Repository | `https://github.com/ydsveluvolu2996/Sutra.git` |
| Branch | `agent/mac-mini-finops-continuation` |
| Draft PR | `https://github.com/ydsveluvolu2996/Sutra/pull/26` |
| Last fully tracked status commit | `d5b2f0608271a2a129b3b38075202b53de072ad3` |
| Complete remaining-work WIP snapshot | `b75f751` (`wip(finops): snapshot remaining dashboard verticals`) |
| Release scope | 27 AWS-backed dashboards |
| Explicitly excluded from this build | ADD-02 Azure CID and ADD-03 GCP CID |
| Deployment performed | No |
| Production image changed | No |

The WIP snapshot contains every uncommitted file that existed when work stopped: 185 files, 10,958 insertions and 432 deletions. It was pushed intentionally as one WIP safety commit so no agent output is only local.

## Snapshot health

These checks passed against `b75f751` after all agents were stopped:

```text
pnpm typecheck                 PASS
pnpm typecheck:collector       PASS
pnpm security:secrets          PASS (2,460 source files)
git diff --check               PASS
```

`cfn-lint` 1.46.0 is installed at:

```text
/Users/Shared/sutra-codex/tools/cfnlint-venv/bin/cfn-lint
```

Before the WIP snapshot, the full 13-template CloudFormation gate through permission pack `.8.11` passed. The repository script suppressed only its documented inherited Bedrock catalog false positives.

The authoritative dashboard tracker intentionally remains at **15 local candidates, 14 partial pipelines total**, which means **15/27 in-scope AWS dashboards are local candidates and 12/27 remain partial**. Do not change those counts merely because the WIP snapshot contains substantial code.

## Fully closed and independently committed verticals

The following were completed as isolated feature commits and then recorded by isolated tracker commits:

| Dashboard | Feature commit | Tracker commit | Local state |
|---|---|---|---|
| ADV-07 AWS News Feeds | `ddc448b` | `398fa9e` | Candidate |
| ADV-02 Compute Optimizer | `f96b73a` | `9561050` | Candidate |
| ADV-08 AWS Budgets | `e2551db` | `8b8745c` | Candidate |
| ADV-04 Extended Support | `963a54e` | `5ba771f` | Candidate |
| ADV-09 Support Cases Radar | `6d5699b` | `3f1ae64` | Candidate |
| ADV-06 AWS Health Events | `6dab352` | `ec18b0d` | Candidate |
| ADV-10 ResilienceVue | `d1e91bf` | `ffbe454` | Candidate |
| ADV-12 Data Collection Monitor | `24c78c9` | `22b9fce` | Candidate |
| ADV-11 End User Computing | `98265d5` | `d5b2f06` | Candidate |

The tracker already included six earlier candidates: FND-01 CUDOS, FND-02 Cost Intelligence, FND-03 KPI and Modernization, ADV-03 Cost Anomaly, ADD-09 Trends and ADD-10 Data Transfer.

## Remaining 12 in-scope partial dashboards

### 1. ADV-05 Graviton Savings — finish this first

The WIP snapshot contains the nearly complete shared `.8.12` integration plus the previously green unique vertical.

Implemented in the snapshot:

- immutable `standard-2026-08.12` template;
- pinned `@aws-sdk/client-auto-scaling@3.1087.0`;
- concrete bounded cross-service reader and strict provider route;
- exact Graviton action/session contracts (OpenSearch uses the correct `es:` IAM prefix);
- Drizzle `0122` and PostgreSQL `0118` migration files;
- D1 registry, CLI migration list, local registry, role broker, collector route;
- shared handler/daily tick, Ed25519 evidence signer, authority-row binding and activation;
- predecessor catalog extension through `.8.12`;
- 33/33 focused Graviton/successor/collector tests were reported green before the stop;
- root and collector typechecks pass in the WIP snapshot.

Known concrete gap to fix before promotion:

- `db/postgres-runtime-migrations.ts` does **not** import/register `postgres/migrations/0118_finops_graviton_runtime.sql`, although `scripts/postgres-migrate.mjs` does. Add it and prove migration parity.

Then rerun focused tests, root/collector typechecks and builds, lint, secrets, native CFN lint, PostgreSQL migration tests, and predecessor D1 regressions. Only then create an isolated Graviton completion commit and promote ADV-05 in the tracker.

### 2. ADD-05 Marketplace SPG — unique vertical complete, shared integration pending

WIP state reported green: 30/30 focused tests, collector typecheck, ESLint, diff and secrets.

Implemented: buyer-only adapter/route, signed broker, durable runtime repository, production composition, approved SOFTWARE/DATA/PROFESSIONAL_SERVICES taxonomy, four-state API/UI, Drizzle `0123`, PostgreSQL `0119`.

Remaining shared work:

- add pinned SDK dependencies: `@aws-sdk/client-marketplace-agreement`, `@aws-sdk/client-marketplace-discovery`, `@aws-sdk/client-license-manager` at `3.1087.0`;
- create immutable `.8.13` successor preserving `.8.12`;
- exact role-broker/session/local-server/handler/tick/migration registration;
- extend predecessor app allowlists through `.8.13`;
- keep Bedrock classification explicitly unavailable without authoritative evidence.

### 3. ADD-01 CORA — unique vertical complete, shared integration pending

WIP state reported green: 43/43 app/runtime, 3/3 provider, 4/4 durable lease tests, collector typecheck/build, lint/diff/secrets.

Implemented: strict export adapter/route, signed broker, production composition, dedicated 17-minute CAS lease/replay repository, Drizzle `0124`, PostgreSQL `0120`, API/UI states and exact evidence handling.

Remaining shared work:

- create immutable `.8.14` successor;
- register migrations and handler/tick/collector/role-broker hooks;
- add pinned `@aws-sdk/client-bcm-data-exports@3.1087.0` and `@aws-sdk/client-cost-optimization-hub@3.1087.0`;
- select and pin a bounded Parquet decoder only after license/security review;
- extend predecessor app allowlists through `.8.14`.

### 4. ADD-08 Sustainability and Carbon — unique vertical complete, shared integration pending

WIP state reported green: 31/31 focused tests, 4/4 collector tests, root/collector typechecks/build, lint/diff/secrets.

Implemented: strict provider/export route, signed broker, durable runtime, governed target repository/API, evidence-gated optional dimensions, Drizzle `0126`, PostgreSQL `0122`, exact 6-sheet/25-visual/17-control UI. Export, proxy and optional direct-API comparator are kept separate.

Remaining shared work:

- create immutable `.8.15` successor with exact S3/Data Exports/Sustainability reads;
- register migrations, role/route/handler/daily tick and production loaders;
- extend predecessor app allowlists through `.8.15`;
- never merge proxy estimates with provider emissions or invent carbon factors.

### 5. ADD-11 Amazon Connect Cost Insights — unique vertical complete, shared integration pending

WIP state reported green: 33/33 focused tests, root/collector typechecks, lint/diff/secrets.

Implemented: Connect adapter/default client/strict route, exact instance ARN and `TargetArn` controls, privacy aggregation/HMAC identifiers, durable 17-minute lease/replay, signed broker, daily composition, Drizzle `0127`, PostgreSQL `0123`, four-state API/UI.

Remaining shared work:

- add `@aws-sdk/client-connect@3.1087.0`;
- create immutable `.8.16` successor with exact `connect:DescribeInstance`, `connect:ListPhoneNumbersV2` and `ds:DescribeDirectories` grants;
- register migrations, route, broker, handler/tick and canonical CUR2/evidence loaders;
- extend predecessor app allowlists through `.8.16`;
- keep unpublished `resource_connect_view`, supporting-service evidence and privileged contact lookup unavailable.

### 6. ADD-13 Pricing Change Analysis — unique vertical complete, shared integration pending

WIP state reported green: 33 existing regressions, 4 production closure tests, 3 collector tests, lint/diff/secrets.

Implemented: 1,001-row-capable CUR2 reader, real historical Price List reader/route, signed broker, durable repository/composition, Drizzle `0128`, PostgreSQL `0124`, runtime UI state.

Remaining shared work:

- create immutable `.8.17` successor with only `pricing:ListPriceLists` and `pricing:GetPriceListFileUrl` on `*`;
- register migrations, route, handler/daily tick and signed production composition;
- extend predecessor app allowlists through `.8.17`;
- preserve the official Guidance/manifest category and version discrepancies explicitly.

### 7. ADD-12 Config Resource Compliance — unique vertical complete, shared integration pending

WIP state reported green: 23/23 engine/job/runtime/official, 4/4 UI, 3/3 provider, 3/3 production, root/collector typechecks/build, lint/diff/secrets.

Implemented: Config/Organizations paginator and sanitizer, strict signed route, durable daily runtime, Drizzle `0129`, PostgreSQL `0125`, exact 7-sheet/124-visual/64-control/13-dataset/14-view UI and four states.

Remaining shared work:

- add `@aws-sdk/client-config-service@3.1087.0`;
- create immutable `.8.18` successor with exact Config/Organizations and optional contract-bound S3 reads;
- register migrations, route, broker, handler/tick and activation;
- extend predecessor app allowlists through `.8.18`;
- do not substitute Security Hub or CloudTrail for missing versioned evidence.

### 8. ADD-04 FOCUS — work was only audited/reserved at stop time

Reserved continuation:

- permission successor `.8.19`;
- Drizzle `0130`, PostgreSQL `0126`;
- add `@aws-sdk/client-bcm-data-exports@3.1087.0`;
- exact persisted export ARN/bucket/prefix scope;
- build durable discovery/materialization/runtime state and shared registration;
- keep excluded Azure/GCP provider paths explicitly unavailable rather than fabricating parity.

No substantial new FOCUS implementation was included in `b75f751`; continue from the existing partial pipeline.

### 9. ADD-06 Kubecost Allocation — unique vertical complete, shared integration pending

WIP state reported green: 36/36 focused tests, root/collector typechecks, lint/diff/secrets.

Implemented: corrected daily Snappy Parquet schema 2.0.0, exact 62 columns and node dimensions, version-pinned S3 reader, strict route, six-hour composition and four states.

No new migration, SDK or permission pack is required. Register the route, exact bucket/prefix/CMK session policy, handler/tick and activation. Accept only the explicit known permission-pack allowlist starting at `.8.9`; never use lexical version comparison.

### 10. ADD-07 SCAD Allocation — unique vertical complete, shared integration pending

WIP state reported green: 19/19 closure, 7/7 vertical, 2/2 provider plus CAS recovery, root/collector typechecks, lint/secrets.

Implemented: strict CUR2 route, signed provider, dedicated 31-minute CAS ledger, Drizzle `0125`, PostgreSQL `0121`, PERSISTED checkpoint/orphan recovery/four-state UI.

No new permission pack or SDK is needed. Register migrations and exact `foundational-cur2-export-v1` route/session/handler/daily tick. Do not fabricate non-SCAD TCO or EMR joins.

### 11. ADV-01 Trusted Advisor Organizational

This remains partial in the authoritative tracker. It was not materially advanced in the WIP snapshot. Complete the previously documented secret rotation, permission-pack activation, eligible Support-plan reconciliation, authoritative TA Priority/Well-Architected sources, conditional Security Hub classification, provider/two-tenant acceptance and fixed-tree gates.

### 12. ADV-13 Media Services Insights Hub

This remains partial and was not materially advanced in the WIP snapshot. Finish reservation savings, Budgets, CloudWatch/performance evidence, provider registration, reconciliation and live acceptance without inventing unsupported dimensions.

## Permission-pack sequence — do not collide or mutate old templates

| Version | Owner |
|---|---|
| `.8.5` | Compute Optimizer |
| `.8.6` | Extended Support |
| `.8.7` | Support Cases |
| `.8.8` | Health Events |
| `.8.9` | ResilienceVue |
| `.8.10` | Data Collection Monitor |
| `.8.11` | End User Computing |
| `.8.12` | Graviton (in WIP snapshot) |
| `.8.13` | Marketplace SPG |
| `.8.14` | CORA |
| `.8.15` | Sustainability |
| `.8.16` | Amazon Connect |
| `.8.17` | Pricing Change |
| `.8.18` | Config Compliance |
| `.8.19` | FOCUS (reserved) |

Every successor must be immutable, preserve every prior policy, extend the central explicit app allowlists, and include D1 regressions. Never accept versions by string ordering or an open-ended regex.

## Migration reservations — preserve this exact order

| Dashboard | Drizzle | PostgreSQL |
|---|---:|---:|
| Graviton | `0122` | `0118` |
| Marketplace SPG | `0123` | `0119` |
| CORA | `0124` | `0120` |
| SCAD | `0125` | `0121` |
| Sustainability | `0126` | `0122` |
| Amazon Connect | `0127` | `0123` |
| Pricing Change | `0128` | `0124` |
| Config Compliance | `0129` | `0125` |
| FOCUS reserved | `0130` | `0126` |

For every vertical, update all three registries together:

- `db/runtime-migrations.ts`
- `db/postgres-runtime-migrations.ts`
- `scripts/postgres-migrate.mjs`

Then run SQLite and PostgreSQL migration parity tests before promotion.

## Recommended continuation order

1. Checkout/pull `agent/mac-mini-finops-continuation`; confirm `HEAD` contains `b75f751` and this handover commit.
2. Run `pnpm install --frozen-lockfile`, root and collector typechecks, secrets and `git diff --check`.
3. Finish Graviton `.8.12` first, especially the missing PostgreSQL runtime registry entry; validate and commit it separately; then promote ADV-05 in a separate tracker commit.
4. Integrate one shared vertical at a time in permission order: Marketplace `.8.13`, CORA `.8.14`, Sustainability `.8.15`, Amazon Connect `.8.16`, Pricing `.8.17`, Config `.8.18`, FOCUS `.8.19`.
5. Integrate Kubecost and SCAD exact S3/CUR2 bindings without creating unnecessary new permission versions.
6. Finish Trusted Advisor Organizational and Media Services Insights Hub.
7. Only after all 27 in-scope rows are local candidates/verified, run the full fixed-SHA release matrix: root/collector typechecks and builds, all test shards, PostgreSQL 16 migrations/runtime roles, rendered/accessibility tests, lint, secret scan, Trivy/SBOM, Docker/compose/rollback.
8. Perform controlled AWS provider reconciliation and signed-in two-tenant acceptance.
9. Merge/review, publish one immutable image, deploy through the existing private-beta workflow, and capture live/rollback proof.

## Commands for the next agent

```bash
cd /Users/Shared/sutra-codex/Sutra
git switch agent/mac-mini-finops-continuation
git pull --ff-only origin agent/mac-mini-finops-continuation
git status --short
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:collector
pnpm security:secrets
git diff --check
PATH=/Users/Shared/sutra-codex/tools/cfnlint-venv/bin:$PATH pnpm lint:cloudformation
```

Use Node `v22.23.2` for authoritative full-suite evidence. A prior 365/367 collector run under Node 22.16 had two environment-only dynamic `.ts` import failures in compiled local-server tests; rerun with the repository-approved Node before classifying them as product failures.

## Release safety rules

- Do not merge the WIP snapshot directly to main as a completed release.
- Do not promote a tracker row until collector → persistence → scheduler/handler → API → UI/states → tests are all wired.
- Do not deploy or publish an image until all 27 in-scope dashboards and fixed-tree/provider/two-tenant gates pass.
- Never alter older permission templates in place.
- Never stage unrelated agent work into a vertical completion commit; use explicit file staging.
- Preserve Azure/GCP catalog rows but keep ADD-02/ADD-03 excluded from this build.

Production remained unchanged throughout this handoff.
