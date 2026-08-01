# ADV-04 — Extended Support Cost Projection evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/extended-support.html>

Official visual reference: <https://docs.aws.amazon.com/images/guidance/latest/cloud-intelligence-dashboards/images/rdsxtsuppcp.png>

Assessment revision: `17da4c5989b4`

Current maturity: `ENGINE_ONLY`

## Official requirement and visual inventory

The current official dashboard covers ElastiCache, EKS, RDS, and OpenSearch
resources that have reached or are approaching Extended Support. It identifies
resources entering Extended Support in the next 3, 6, 12 months and beyond,
shows estimated monthly incremental support cost, and drills down to the
cluster, database instance, or domain. The prerequisites are the Foundational
dashboards for actual usage/cost and Data Collection Lab Inventory Data 3.2.0
or later.

Acceptance cases include service/account/Region/resource and engine-version
coverage, authoritative lifecycle calendars, date- and Region-specific rates,
explicit enrollment, separate actual versus projected cost, stale/missing
calendar and price states, signed CUR corrections, horizons, and no-change
projection assumptions.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Current AWS guide and official dashboard image above, reviewed 2026-08-01. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | The pure engine pins read-only EKS, RDS/Aurora, OpenSearch, ElastiCache and Price List operations plus authoritative documentation/pricing/CUR2 evidence references. Tenant-owned accounts/Regions and management account are repeated in every capture. |
| G2 collector | `NOT_STARTED` | The runtime registry exposes a processor contract, but the AWS collector has no concrete multi-account/Region Extended Support runner producing inventory, calendar, rate and reconciled-charge capture. Generic readiness is not collection proof. |
| G3 persistence | `NOT_STARTED` | Generic source snapshot primitives exist but no Extended Support materialization parser, evidence-object binding, history projection, or capability-specific accepted-head contract is wired. |
| G4 API | `NOT_STARTED` | No authenticated Extended Support report route currently reads and verifies accepted evidence. |
| G5 visual UI | `NOT_STARTED` | No native dashboard currently renders horizons, services, lifecycle bands, estimated monthly cost, resource drilldown and evidence states. |
| G6 focused verification | `VERIFIED` | Exact revision `17da4c5989b4`: 9 engine tests pass with 0 failures/skips, including five-service separation, missing inputs, enrollment, duplicate/history bounds, tenant scope, complete-empty/stale sources, stale calendars/rates, and read-only operations. |
| G7–G10 | `NOT_STARTED` | Exact-tree, controlled provider, reviewed release, immutable deployment and live acceptance remain. |

## Evidence-honesty limits

The engine separates `RECONCILED_ACTUAL_EXTENDED_SUPPORT_COST` from
`PROJECTED_INCREMENTAL_EXTENDED_SUPPORT_COST_IF_UNCHANGED`. A projection is not
normal service spend, a quote, or a savings promise. Missing version, calendar,
rate, basis, enrollment, quantity, or currency evidence stays unavailable; it
never becomes zero. The current engine uses validated numeric price inputs,
not an exact-micros monetary representation, which must be reviewed before G7.

Focused command:

```text
node --experimental-strip-types --test tests/finops-extended-support-projection.test.ts
```

Result: **9 passed, 0 failed, 0 skipped**.
