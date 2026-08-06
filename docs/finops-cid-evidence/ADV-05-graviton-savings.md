# ADV-05 — Graviton Savings Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/graviton-savings-dashboard.html>

Current maturity: `NATIVE_FUNCTIONAL_WITH_PROVIDER_GAPS`

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
| Live provider/deployment | `OPEN` | No production collector adapter, scheduled materialization, provider reconciliation, reviewed release, image or live acceptance is claimed. |

## G1-G6 status

| Gate | Status | Evidence / remaining work |
|---|---|---|
| G1 — official requirements and visual inventory | `VERIFIED` | Immutable manifest/definition hashes plus exact sheet, visual-type, control, parameter, calculated-field, filter-group, column-configuration, and dataset counts are frozen and arithmetically tested. |
| G2 — source/materializer contract | `LOCAL_COMPLETE` | Four service families, canonical CUR2/pricing/inventory/metadata, recommendation authority, compatibility dimensions, bounds and no-inference policy are explicit. |
| G3 — durable runtime/replay | `PARTIAL` | Prevalidated identity-only daily scheduling, deterministic request identity, strict five-attempt jobs and validated signed receipt verification are implemented and tested. Durable handler registration, real archive/sealer, credential broker and provider adapter remain open. |
| G4 — persistence/API | `LOCAL_COMPLETE` | Immutable complete-only head, registered SQLite/Postgres migrations, tenant-scoped authenticated API, bounded filters/cursor, history and freshness. |
| G5 — native UI | `LOCAL_COMPLETE_WITH_EXPLICIT_GAPS` | All seven official sheet contracts render with exact upstream counts and native evidence mapping. Existing usage, service economics, trends, eligibility, blockers and evidence render. Instance Mapping, EC2 generation/performance controls, tags and managed-service RI/purchase-option analysis remain visibly open; exact layout parity is not claimed. |
| G6 — validation/acceptance | `PARTIAL` | Focused engine, runtime, persistence, route and SSR tests plus lint/type checks pass locally. Live AWS, exact-tree browser/a11y and production smoke evidence remain open. |

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

1. Register the durable job handler and bind a persistent signed-receipt
   archive, verifier, sealer and credential-owning collector adapter.
2. Bind complete Compute Optimizer coverage where AWS publishes it, exact
   OpenSearch/ElastiCache inventory, AWS Price List products, canonical CUR2,
   service metadata and approved workload/license attestations.
3. Confirm live feature/engine/version compatibility for Aurora, OpenSearch and
   ElastiCache; managed-service inventory alone is not compatibility proof.
4. Implement the currently disclosed standalone Instance Mapping table,
   generation/performance, cost-allocation tag, purchase-option/RI and
   service-specific controls before claiming functional control parity. Exact
   QuickSight layout parity is intentionally not claimed.
5. Run two-tenant, multi-account/Region, pagination/throttling, history,
   reconciliation, empty/partial and provider-correction acceptance.
6. Complete reviewed release, immutable image deployment and live UI acceptance.

Until these gates pass, the API reports
`GRAVITON_CROSS_SERVICE_MATERIALIZER_NOT_DEPLOYED`. This vertical is locally
implemented but has not passed the exact-tree, provider, or live acceptance
gates.

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
