# ADV-05 — Graviton Savings Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/graviton-savings-dashboard.html>

Current maturity: `LOCAL_VERTICAL_CANDIDATE`

## Official coverage

The local model now covers existing Graviton usage and migration opportunities
across EC2/Auto Scaling, RDS/Aurora, OpenSearch, and ElastiCache. It provides
account, Region, service, eligibility, and currency filters; service summaries;
monthly usage/potential/realized trends; workload drilldown; evidence lineage;
and formula-safe CSV export.

The official v3.0.2 definition was audited at CID framework commit
`f9e36d88c47709f10e8fa784ad11d5cc0e728021`:
<https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/graviton-savings-dashboard/graviton_savings_dashboard-definition.yaml>.
Its seven sheets are **Summary**, **EC2**, **RDS**, **ElastiCache**,
**OpenSearch**, **Graviton Instance Mapping**, and **About**. The official
changelog also identifies performance-based EC2 modeling, Graviton-generation
selection, cost-allocation tag filters, Reserved Instance analysis, and
service-specific eligibility/mapping corrections. Sutra does not claim exact
parity for controls or visuals that its normalized model does not expose.

### Immutable upstream definition evidence

| Evidence | Pinned value |
|---|---|
| Repository | `aws-solutions-library-samples/cloud-intelligence-dashboards-framework` |
| Commit | `f9e36d88c47709f10e8fa784ad11d5cc0e728021` |
| Manifest | `dashboards/graviton-savings-dashboard/graviton_savings_dashboard.yaml` |
| Manifest SHA-256 | `a91ec6d00d530fb126c2e235a7ac2b3b69f7d1d2a72c9e86df7b6858c6178eb3` |
| Definition | `dashboards/graviton-savings-dashboard/graviton_savings_dashboard-definition.yaml` |
| Definition SHA-256 | `2dd6358149ac7457de1a1ca0de9c4fcf651eaea7685f7554a27ae338df392ec8` |
| Dashboard/version/theme | `graviton-savings` / `v3.0.2` / `MIDNIGHT` |
| Dataset declarations | `graviton_mapping`, OpenSearch, ElastiCache, EC2, and RDS dashboard datasets |

Independent parsing of the pinned QuickSight definition produced **7 sheets,
122 visuals, 39 parameter controls, 14 filter controls, 44 parameter
declarations, 68 calculated fields, 469 filter groups, and 48 column
configurations**. The visual histogram is 37 KPI, 29 bar-chart, 9 pivot-table,
12 combo-chart, 1 waterfall, 16 insight, 17 pie-chart, and 1 table object.

| Official sheet | Exact visual inventory | Controls | Native evidence mapping / explicit gap |
|---|---:|---:|---|
| Summary | 20: 16 KPI, 4 bar | 3 parameter | Existing ARM64 usage, service economics, eligibility, and trends are native. Exact upstream multi-payer/account-name KPI layout is not claimed. |
| EC2 | 28: 3 pivot, 6 bar, 6 combo, 1 waterfall, 6 KPI, 4 insight, 2 pie | 9 parameter, 6 filter | EC2/Auto Scaling usage, compatibility, effort, economics, and authoritative provider estimates are native. Generation, NIH, OS, family, processor, and purchase-option controls remain absent. |
| RDS | 26: 2 combo, 7 bar, 5 insight, 2 pivot, 5 pie, 5 KPI | 10 parameter, 1 filter | RDS/Aurora evidence is native. Engine/version, deployment, family, RDS-type, and purchase-option controls need richer projection fields. |
| ElastiCache | 25: 2 pivot, 7 bar, 5 KPI, 2 combo, 5 pie, 4 insight | 8 parameter, 1 filter | Inventory, compatibility, economics, and drilldown are native without fabricated Compute Optimizer values. Engine/version, family, target instance, and purchase option remain open. |
| OpenSearch | 22: 2 combo, 5 bar, 5 KPI, 2 pivot, 5 pie, 3 insight | 8 parameter | Inventory, compatibility, economics, and drilldown are native without fabricated Compute Optimizer values. Engine/version, family, and purchase option remain open. |
| Graviton Instance Mapping | 1 table | 1 parameter, 6 filter | Versioned metadata/pricing are enforced by the model but no standalone tenant-safe mapping table or six commercial filters are exposed. |
| About | 0 | 0 | Immutable definition, freshness, collection, lineage, history, and disclosures are native. The pinned sheet contains no visual objects. |

This is an exact object inventory and evidence mapping, not an exact QuickSight
layout or styling claim.

| Gate | Status | Evidence |
|---|---|---|
| Source contract | `LOCAL_COMPLETE` | `lib/finops-graviton-savings.ts` recognizes all six concrete resource types and requires canonical CUR2, versioned pricing, inventory/metadata and five explicit compatibility dimensions. |
| Collector/materializer contract | `LOCAL_COMPLETE` | `lib/finops-graviton-savings-job.ts` pins tenant accounts/Regions, four service families, read-only operations, bounds, deadline and no-inference policy. |
| Durable scheduling/replay contract | `LOCAL_COMPLETE` | `lib/finops-graviton-runtime-binding.ts` prevalidates eligible scopes, schedules identity-only daily jobs with five attempts, reloads and validates canonical tenant/account/Region boundaries, derives tenant/window/boundary request identity, passes it to the collector, validates and verifies signed replay receipts, skips provider/store writes on verified replay, and returns an explicit adapter-unavailable state. |
| Persistence | `LOCAL_COMPLETE` | SQLite 0103, PostgreSQL 0098 and `db/finops-graviton-savings-repository.ts` provide content-addressed immutable history with a newer `COMPLETE`-only head. |
| API | `LOCAL_COMPLETE` | Authenticated same-tenant `connection:read` API with bounded filters, freshness, accepted/latest lineage, honest configuration state, and frozen official-definition evidence in configured and configuration-required responses. |
| Native UI | `LOCAL_COMPLETE_WITH_EXPLICIT_GAPS` | All seven official sheets and exact object/control counts are visible with evidence/gap mappings; existing ARM64 usage, four-service economics, trends, evidence-class separation, blockers, drilldown and safe visible-row export remain native. |
| Focused verification | `LOCAL_COMPLETE` | Engine and vertical suites cover exact micros, service contracts, provider-estimate restrictions, missing compatibility, reconciliation, adversarial scope, immutable heads, API and SSR UI. |
| Live provider/deployment | `PENDING_EXTERNAL_ACCEPTANCE` | The production collector boundary and scheduled materialization are locally registered. Real AWS reconciliation, signed-in two-tenant acceptance, reviewed release, image, and live acceptance are not claimed. |

## G1-G6 status

| Gate | Status | Evidence / remaining work |
|---|---|---|
| G1 — official requirements and visual inventory | `VERIFIED` | Immutable manifest/definition hashes plus exact sheet, visual-type, control, parameter, calculated-field, filter-group, column-configuration, and dataset counts are frozen and arithmetically tested. |
| G2 — source/materializer contract | `LOCAL_COMPLETE` | Four service families, canonical CUR2/pricing/inventory/metadata, recommendation authority, compatibility dimensions, bounds and no-inference policy are explicit. |
| G3 — durable runtime/replay | `LOCAL_COMPLETE` | Prevalidated identity-only daily scheduling, deterministic request identity, strict five-attempt jobs, CAS lease/replay, immutable signed receipts, shared handler/tick registration, evidence signer, broker, and collector provider route are implemented and tested. |
| G4 — persistence/API | `LOCAL_COMPLETE` | Immutable complete-only head, registered SQLite/Postgres migrations, tenant-scoped authenticated API, bounded filters/cursor, history and freshness. |
| G5 — native UI | `LOCAL_COMPLETE_WITH_EXPLICIT_GAPS` | All seven official sheet contracts render with exact upstream counts and native evidence mapping. Existing usage, service economics, trends, eligibility, blockers and evidence render. Instance Mapping, EC2 generation/performance controls, tags and managed-service RI/purchase-option analysis remain visibly open; exact layout parity is not claimed. |
| G6 — validation/acceptance | `LOCAL_COMPLETE` | At baseline `2e9b8a7`, focused engine, runtime, persistence, route, cross-tenant, SSR, provider-route, permission/predecessor, SQLite/PostgreSQL migration, typecheck/build, ESLint, secret, and CloudFormation checks pass locally. Live AWS, signed-in exact-tree browser/a11y, and production smoke evidence remain external. |

## Evidence-honesty rules

- ARM64 CUR2 rows quantify existing Graviton usage; an instance-family suffix is
  never interpreted as architecture.
- EC2/Auto Scaling and RDS/Aurora can carry an AWS Compute Optimizer estimate
  only when the recommendation source is the exact Compute Optimizer API.
- OpenSearch and ElastiCache may enter the opportunity pipeline from exact
  service inventory evidence, but that evidence cannot carry a fabricated
  Compute Optimizer estimate.
- All services require affirmative architecture, OS/managed-runtime, licensing,
  workload and service-feature compatibility. Missing or review-required
  evidence blocks modeled savings.
- Modeled potential requires one period-matched public-on-demand CUR2 baseline,
  current and target price-list records, and ARM64 target metadata. Exact BigInt
  micro-unit reconciliation must succeed.
- Provider estimate, modeled potential, and measured realized savings remain
  separate. Missing evidence is unavailable, never zero.
- Currency and billing periods never combine.

## New assets

- `lib/finops-graviton-dashboard.ts`
- `lib/finops-graviton-savings-official-definition.ts`
- `lib/finops-graviton-savings-job.ts`
- `lib/finops-graviton-runtime-binding.ts`
- `db/finops-graviton-savings-repository.ts`
- `drizzle/0103_finops_graviton_savings.sql`
- `postgres/migrations/0098_finops_graviton_savings.sql`
- `app/api/v1/finops/graviton-savings/route.ts`
- `app/costs/finops-graviton-savings-dashboard.tsx`
- `tests/finops-graviton-savings-vertical.test.mjs`
- `tests/finops-graviton-savings-official-definition.test.ts`
- `tests/finops-graviton-runtime-binding.test.ts`

## Remaining provider and activation gaps

1. Bind complete Compute Optimizer coverage where AWS publishes it, exact
   OpenSearch/ElastiCache inventory, AWS Price List products, canonical CUR2,
   service metadata and approved workload/license attestations.
2. Confirm live feature/engine/version compatibility for Aurora, OpenSearch and
   ElastiCache; managed-service inventory alone is not compatibility proof.
3. Implement the currently disclosed standalone Instance Mapping table,
   generation/performance, cost-allocation tag, purchase-option/RI and
   service-specific controls before claiming functional control parity. Exact
   QuickSight layout parity is intentionally not claimed.
4. Run two-tenant, multi-account/Region, pagination/throttling, history,
   reconciliation, empty/partial and provider-correction acceptance.
5. Complete reviewed release, immutable image deployment and live UI acceptance.

Until configured authority and provider evidence exists, the API preserves
configuration-required/collecting/failed states and the last accepted snapshot;
it does not report a truthful-looking zero. This vertical is a local candidate
and has not passed provider, exact-tree signed-in, or live acceptance gates.

## Focused validation

```text
node --experimental-strip-types --test --test-concurrency=1 \
  tests/finops-graviton-savings-official-definition.test.ts \
  tests/finops-graviton-savings-vertical.test.mjs \
  tests/finops-graviton-savings.test.ts \
  tests/finops-graviton-runtime-binding.test.ts
```

Result: **26 passed, 0 failed, 0 skipped**.

```text
pnpm typecheck
pnpm exec eslint \
  app/api/v1/finops/graviton-savings/route.ts \
  app/costs/finops-graviton-savings-dashboard.tsx \
  lib/finops-graviton-savings-official-definition.ts \
  tests/finops-graviton-savings-official-definition.test.ts \
  tests/finops-graviton-savings-vertical.test.mjs
git diff --check
```

Result: **all passed**.

## Merge record — 2026-08-06

Merged to `main` since this record was last updated (2026-08-05 15:01). Every
item below is source-only work that landed through review with CI green on the
merge commit — nothing more. No provider, live, two-tenant, or release evidence
is created by any of it.

**Maturity is unchanged (`PARTIAL_PIPELINE`) and no child-stage gate passed.** G7
fixed-tree, G8 controlled provider acceptance, G9 release and G10 deployment
remain unpassed for this row; no live acceptance, provider reconciliation, or
two-tenant acceptance is claimed.

- **Native chart kit and catalog identity — `4ac72bd` (PR #36) and `f107cdf`
  (PR #37).** This row's view was already on the native chart kit before these
  merges (its monthly Graviton savings trend was charted at `8542be3`, an ancestor of `4ac72bd`), and neither its view module nor a shared panel it renders was
  modified. Across `app/costs/`, 28 view modules plus the catalog page now import the kit,
  and the kit's own rendering suite `tests/chart-kit-rendering.test.mjs` holds
  12 tests. `app/costs/finops-dashboard-identity.tsx` renders each dashboard's
  catalog glyph, name and ID above every opened view
  (`tests/finops-dashboard-identity.test.mjs`). This is UI rendering work only:
  no source contract, collector operation, migration, API shape, or evidence
  semantic changed, and no G5 or G6 stage status is promoted by it.

## Closure worksheet — 2026-08-21

### Identity and starting state

| Field | Value |
|---|---|
| Dashboard ID and name | ADV-05 — Graviton Savings Dashboard |
| Sutra dashboard ID | `graviton_savings` |
| Starting branch | `develop` |
| Starting SHA | `2e9b8a7d76a91e711d79e9a0c739d278fb2c2c1c` |
| Required predecessor | Immutable `standard-2026-08.11` permission pack |
| Permission reservation | `standard-2026-08.12` |
| Drizzle/PostgreSQL reservations | `0122` / `0118` |
| Primary implementer / shared-file integrator | Codex `/root`; no parallel agents |
| Aliases searched | `graviton`, `graviton_savings`, `graviton-savings`, `standard-2026-08.12`, `0122_finops_graviton_runtime`, `0118_finops_graviton_runtime` |

The clean starting state was `develop...origin/develop` at the SHA above, with
Node `v22.23.2` and pnpm `11.13.1`. `pnpm work:start` completed successfully and
confirmed the same remote SHA.

### Existing-asset reuse inventory

| Surface | Existing files/symbols | Classification | Proof or exact gap | Planned action |
|---|---|---|---|---|
| Official definition/evidence | `lib/finops-graviton-savings-official-definition.ts`, this record | `REUSE_AS_IS` | Pinned upstream commit, hashes, seven sheets, and exact object inventory are already tested. | Freeze; refresh same-SHA verification evidence only. |
| Domain/formulas | `lib/finops-graviton-savings.ts`, `lib/finops-graviton-dashboard.ts` | `REUSE_AS_IS` | Exact micros, currency separation, no family-name inference, explicit blockers, and output bounds exist. | Freeze unless a focused test fails. |
| Collector adapter and SDK reader | `services/aws-collector/src/graviton-savings-{provider-adapter,sdk-reader}.ts` | `REUSE_AS_IS` | Credential-owned bounded AWS SDK calls and fail-closed empty authority-dependent projections exist; provider reconciliation remains external. | Verify route/provider tests; retain `PENDING_EXTERNAL_ACCEPTANCE`. |
| Provider route/session/IAM | provider route, permission contract, session policy, role broker, local server, immutable `.8.12` template | `REUSE_AS_IS` | Exact tenant/customer/connection/request/deadline binding and enumerated read-only actions are registered. | Run permission, predecessor, route, and CloudFormation checks. |
| Persistence and registries | Drizzle `0122`, PostgreSQL `0118`, runtime repositories, all three registries | `REUSE_AS_IS` | Commit `43c625d` contains the previously missing PostgreSQL runtime registration; closure test names each registry independently. | Run SQLite/PostgreSQL parity and runtime tests. |
| Runtime/orchestration | production composition, signed broker, evidence signer, background handler, daily tick | `REUSE_AS_IS` | Durable lease/replay, immutable successful receipt, signed transport, and scheduled handler are registered. | Run production/runtime and shared-handler tests. |
| Authenticated API | `app/api/v1/finops/graviton-savings/route.ts` | `REUSE_AS_IS` | Server-derived membership scope, bounded filters, truthful runtime status, and last-good snapshot behavior exist. | Run route/vertical and cross-tenant tests. |
| Native UI | dashboard TSX/CSS and dashboard registry | `REUSE_AS_IS` | Seven-sheet native view and explicit unavailable/configuration/failed/ready semantics exist. | Run SSR/render and accessibility-contract tests. |
| Focused/shared tests | Graviton engine, vertical, runtime, provider-route, closure, permissions, migrations | `REUSE_AS_IS` | Coverage includes scope mismatch, replay, lease, immutable heads, signed transport, bounds, registry parity, and predecessor preservation. | Rerun at the current fixed SHA. |
| Documentation/tracker | this record and `docs/FINOPS_CID_IMPLEMENTATION_TRACKER.md` | `REPAIR` | Source still describes shared integration and PostgreSQL `0118` registration as missing although both landed in `43c625d`. | Update only after the final verification matrix passes. |

### Frozen reuse set and bounded edit set

All implementation files listed above are frozen unless a named verification
failure proves a repair is required. The initial bounded edit set is:

```text
docs/finops-cid-evidence/ADV-05-graviton-savings.md
docs/FINOPS_CID_IMPLEMENTATION_TRACKER.md
docs/CLOUDAWARE_AWS_IMPLEMENTATION_LEDGER.md
```

### Contract decisions

| Question | Decision and authoritative basis |
|---|---|
| Provider operations | The 15 exact read-only actions in `GRAVITON_PROVIDER_SESSION_ACTIONS`; immutable `.8.12` adds only those actions to `.8.11`. |
| Bounds/deadline | 15-minute deadline, 1,000 accounts, 50 Regions, bounded record/byte counts, token replay rejection, and exhaustion evidence. |
| Identity binding | Organization, customer, connection, account, partition, Region, request key, and deadline are derived and revalidated server-side. |
| Replay/persistence | One deterministic daily request identity; CAS lease; immutable `SUCCEEDED` receipt; complete-only monotonic snapshot head. |
| Evidence | Tenant-bound signed broker response plus content-addressed CUR2, pricing, compatibility, workload, and license authorities. |
| Money/privacy | Exact integer micros and currency separation; no raw credentials or unbounded customer/provider text. |
| Failure behavior | Missing authority/provider evidence stays configuration-required; failed/stale collection retains last accepted data and never becomes zero. |
| External acceptance | Real AWS, multi-account/Region, and signed-in two-tenant evidence remains `PENDING_EXTERNAL_ACCEPTANCE`; no live claim will be made. |

### Ordered verification and promotion plan

1. Run the focused domain, vertical, runtime, provider-route, shared-registration,
   permission, migration, and UI/render tests.
2. Run root/collector typechecks and builds, affected ESLint, secret scan,
   CloudFormation lint, PostgreSQL migration checks, and `git diff --check`.
3. If all local gates pass, update this record, the authoritative tracker, and
   the CloudAware AWS implementation ledger, then save and push the checkpoint
   to `develop` and inspect the exact standing-PR CI run.

### Candidate verification record

All commands ran on Node `v22.23.2` against implementation baseline
`2e9b8a7d76a91e711d79e9a0c739d278fb2c2c1c` on 2026-08-21.

| Gate | Exact command / result |
|---|---|
| Focused domain/runtime/UI | `node --experimental-strip-types --test --test-concurrency=1` over the five Graviton definition, engine, vertical, binding, and trend suites — **36 passed, 0 failed, 0 skipped**. |
| Durable runtime/shared handler | Production runtime, shared closure, and background-handler suites — **13 passed, 0 failed, 0 skipped**. |
| Collector provider route | Collector build plus `dist/test/graviton-savings-provider-route.test.js` — **4 passed, 0 failed, 0 skipped**. |
| Permission/predecessor/schema contracts | AWS template, `.8.11` predecessor, successor catalog/repository, and schema-parity suites — **12 passed, 0 failed, 1 environment-only PostgreSQL catalog test skipped**; the skipped case was then exercised successfully by the real PostgreSQL run below. |
| PostgreSQL migrations/runtime roles | `scripts/test-postgres.mjs` from an isolated `/Users/Shared` copy because Docker Desktop cannot mount `~/Documents` — **130 migrations applied; 13 passed, 0 failed, 0 skipped** across all emitted TAP suites. |
| Root/collector typecheck | `pnpm typecheck`; `pnpm typecheck:collector` — **passed**. |
| Root/collector build | `pnpm build`; collector `pnpm run build` — **passed**. |
| Affected ESLint | `pnpm exec eslint` over all Graviton app/lib/db/collector/test files — **passed**. |
| Secret scan | `pnpm security:secrets` — **passed for 2,652 source files**. |
| CloudFormation | Recorded venv `cfn-lint` plus `pnpm lint:cloudformation` — **28 templates passed; 42 documented Bedrock catalog false positives suppressed**. |
| Diff integrity | `git diff --check` — **passed** before promotion; rerun after final documentation edits. |

### Handoff and promotion

| Field | Value |
|---|---|
| Feature implementation | `43c625d` (already landed and remote); verified at baseline `2e9b8a7` |
| Evidence/tracker checkpoint | `537da717c7a8050b9fe54f06dacc8361e766f0e6`; remote `develop` matched |
| Evidence file updated | This record |
| Tracker maturity | `PARTIAL_PIPELINE` → `LOCAL_VERTICAL_CANDIDATE` |
| Execution ledger | `docs/CLOUDAWARE_AWS_IMPLEMENTATION_LEDGER.md` |
| Controlled provider/live evidence | `PENDING_EXTERNAL_ACCEPTANCE` |
| Standing PR / CI | [PR #77](https://github.com/ydsveluvolu2996/Sutra/pull/77); [run 32453805907](https://github.com/ydsveluvolu2996/Sutra/actions/runs/32453805907) passed every required job for the exact checkpoint SHA |
| Next dependency-safe slice | Canonical AWS catalog and Navigator foundation |
