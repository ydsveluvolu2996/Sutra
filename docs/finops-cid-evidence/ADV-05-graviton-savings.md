# ADV-05 — Graviton Savings Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/graviton-savings-dashboard.html>

Current maturity: `PARTIAL_PIPELINE (local vertical)`

## Official coverage

The local model now covers existing Graviton usage and migration opportunities
across EC2/Auto Scaling, RDS/Aurora, OpenSearch, and ElastiCache. It provides
account, Region, service, eligibility, and currency filters; service summaries;
monthly usage/potential/realized trends; workload drilldown; evidence lineage;
and formula-safe CSV export.

| Gate | Status | Evidence |
|---|---|---|
| Source contract | `LOCAL_COMPLETE` | `lib/finops-graviton-savings.ts` recognizes all six concrete resource types and requires canonical CUR2, versioned pricing, inventory/metadata and five explicit compatibility dimensions. |
| Collector/materializer contract | `LOCAL_COMPLETE` | `lib/finops-graviton-savings-job.ts` pins tenant accounts/Regions, four service families, read-only operations, bounds, deadline and no-inference policy. |
| Persistence | `LOCAL_COMPLETE` | SQLite 0103, PostgreSQL 0098 and `db/finops-graviton-savings-repository.ts` provide content-addressed immutable history with a newer `COMPLETE`-only head. |
| API | `LOCAL_COMPLETE` | Authenticated same-tenant `connection:read` API with bounded filters, freshness, accepted/latest lineage and honest configuration state. |
| Native UI | `LOCAL_COMPLETE` | Existing ARM64 usage, four-service economics, monthly trends, evidence-class separation, blockers, drilldown and safe visible-row export. |
| Focused verification | `LOCAL_COMPLETE` | Engine and vertical suites cover exact micros, service contracts, provider-estimate restrictions, missing compatibility, reconciliation, adversarial scope, immutable heads, API and SSR UI. |
| Live provider/deployment | `OPEN` | No production collector adapter, scheduled materialization, provider reconciliation, reviewed release, image or live acceptance is claimed. |

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
- `lib/finops-graviton-savings-job.ts`
- `db/finops-graviton-savings-repository.ts`
- `drizzle/0103_finops_graviton_savings.sql`
- `postgres/migrations/0098_finops_graviton_savings.sql`
- `app/api/v1/finops/graviton-savings/route.ts`
- `app/costs/finops-graviton-savings-dashboard.tsx`
- `tests/finops-graviton-savings-vertical.test.mjs`

## Remaining provider and activation gaps

1. Register SQLite 0103, PostgreSQL 0098 and the deploy migrator entry.
2. Wire the native component and catalog maturity.
3. Deploy the signed cross-service collector and schedule materialization.
4. Bind complete Compute Optimizer coverage where AWS publishes it, exact
   OpenSearch/ElastiCache inventory, AWS Price List products, canonical CUR2,
   service metadata and approved workload/license attestations.
5. Confirm live feature/engine/version compatibility for Aurora, OpenSearch and
   ElastiCache; managed-service inventory alone is not compatibility proof.
6. Run two-tenant, multi-account/Region, pagination/throttling, history,
   reconciliation, empty/partial and provider-correction acceptance.
7. Complete reviewed release, immutable image deployment and live UI acceptance.

Until these gates pass, the API reports
`GRAVITON_CROSS_SERVICE_MATERIALIZER_NOT_DEPLOYED`. This vertical is not locally
verified or live.
