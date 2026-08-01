# ADV-04 — Extended Support Cost Projection

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/extended-support.html>

## Status

`PARTIAL_PIPELINE`. The five-service evidence engine, server-owned
multi-account/Region job contract, immutable accepted-generation repository,
authenticated same-tenant API and native planning UI are implemented and
focused-tested. The AWS provider adapter, scheduler, role-policy deployment,
live authoritative evidence and signed-in production acceptance are pending.

## Official coverage

- Amazon ElastiCache cache clusters/replication groups
- Amazon EKS clusters
- Amazon RDS DB instances
- Amazon Aurora DB clusters
- Amazon OpenSearch Service domains

The dashboard provides service/account/Region/engine/version/lifecycle filters,
3/6/12-month planning horizons, effective support and charge dates, explicit
enrollment, usage basis, calendar/pricing freshness, resource drilldown,
projected incremental charge and remediation planning. RDS and Aurora remain
separate evidence classes even though both use RDS APIs.

## Implemented chain

- Engine: `lib/finops-extended-support-projection.ts`
- Job contract: `lib/finops-extended-support-collector-job.ts`
- Exact-money projection: `lib/finops-extended-support-dashboard.ts`
- SQLite: `drizzle/0102_finops_extended_support_projection.sql`
- PostgreSQL: `postgres/migrations/0097_finops_extended_support_projection.sql`
- Repository: `db/finops-extended-support-repository.ts`
- API: `app/api/v1/finops/extended-support-projection/route.ts`
- UI: `app/costs/finops-extended-support-projection-dashboard.tsx`
- Tests: `tests/finops-extended-support-projection.test.ts` and
  `tests/finops-extended-support-vertical.test.mjs`

Captures are normalized against a server-pinned organization/customer/
connection, management account, partition, account set and Region set before
persistence. Immutable generations are content-addressed. Only `READY`
evidence can become the head, and the head advances only to a later collection.

## Projection and exact-money semantics

Actual charges retain `RECONCILED_ACTUAL_EXTENDED_SUPPORT_COST`. Forecasts
retain `PROJECTED_INCREMENTAL_EXTENDED_SUPPORT_COST_IF_UNCHANGED`. A projection
is not normal service cost, an invoice, quote, realized savings or savings
promise. Missing evidence stays unavailable rather than becoming zero.

The legacy engine validates numeric price inputs and seals monetary outputs to
six decimal places. The public projection converts every sealed amount to a
signed integer micro-unit string before aggregation or rendering. Adversarial
tests cover `0.1`, signed one-micro corrections, negative zero, invalid numbers
and integer-micro addition. Provider capture should ultimately move to decimal
or micro strings to remove binary floating-point inputs at ingestion.

## Evidence inputs

- Inventory/version: exact read-only EKS, RDS/Aurora, OpenSearch and
  ElastiCache APIs over server-pinned account/Region fan-out.
- Lifecycle: authoritative AWS APIs/documentation with effective dates.
- Pricing: AWS Price List/public pricing with Region, unit, tier and interval.
- Usage basis: observed authoritative service configuration/usage evidence.
- Actual charges: active reconciled CUR2 Extended Support line items only.

## Remaining provider gates

1. Implement the signed bounded multi-account/Region provider adapter.
2. Deploy and attest least-privilege policies, scheduler and job ledger.
3. Validate calendar/version mappings, normalized OpenSearch factors,
   ElastiCache premiums and Region/date-specific rates against live AWS.
4. Validate real CUR2 charges, corrections, currencies, missing inputs,
   enrollment/version changes and complete-empty cases.
5. Complete adversarial, signed-in accessibility and production acceptance.
6. Move monetary provider fields to signed decimal/micro strings before
   claiming end-to-end exact-money ingestion.

Until these gates pass, ADV-04 is not `LOCAL_VERIFIED` or `LIVE_VERIFIED`.
