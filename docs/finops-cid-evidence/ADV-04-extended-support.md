# ADV-04 — Extended Support Cost Projection

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/extended-support.html>

## Status

`PARTIAL_PIPELINE`. The five-service evidence engine, server-owned
multi-account/Region job contract, identity-only daily scheduler and sealed
replay-safe durable handler boundary, immutable accepted-generation repository,
authenticated same-tenant API and native planning UI are implemented and
focused-tested. The credential-owning AWS provider adapter, permanent replay
store/shared handler registration, role-policy deployment, live authoritative
evidence and signed-in production acceptance are pending.

## Official coverage

The immutable AWS definition is pinned at framework commit
`f9e36d88c47709f10e8fa784ad11d5cc0e728021`, path
`dashboards/extended-support-cost-projection/extended-support-cost-projection-definition.yaml`,
SHA-256 `6e50955ebeab4f2cbcc86c731c939e12c3fe4880d8132514f8de05042cfdb53f`.
It contains exactly **5 sheets, 60 visuals, 17 parameter controls, 0 filter
controls, 11 parameter declarations, 27 calculated fields and 68 filter
groups**. The native dashboard renders the ordered RDS, EKS, OpenSearch,
ElastiCache and About inventory; Aurora remains a separate evidence class in
the official RDS sheet. Exact layout parity is not claimed.

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

The client validates the frozen commit, definition hash, exact totals and
ordered sheet identities before accepting a configuration or report response.
The five-sheet official inventory remains visible during loading,
connection/configuration, failure and report states rather than depending on
an accepted projection generation.

## Implemented chain

- Engine: `lib/finops-extended-support-projection.ts`
- Job contract: `lib/finops-extended-support-collector-job.ts`
- Durable runtime: `lib/finops-extended-support-runtime-binding.ts`
- Exact-money projection: `lib/finops-extended-support-dashboard.ts`
- Official definition: `lib/finops-extended-support-official-definition.ts`
- SQLite: `drizzle/0102_finops_extended_support_projection.sql`
- PostgreSQL: `postgres/migrations/0097_finops_extended_support_projection.sql`
- Repository: `db/finops-extended-support-repository.ts`
- API: `app/api/v1/finops/extended-support-projection/route.ts`
- UI: `app/costs/finops-extended-support-projection-dashboard.tsx`
- Tests: `tests/finops-extended-support-projection.test.ts` and
  `tests/finops-extended-support-vertical.test.mjs` plus
  `tests/finops-extended-support-runtime-binding.test.ts`

Captures are normalized against a server-pinned organization/customer/
connection, management account, partition, account set and Region set before
persistence. The scheduler prevalidates all eligible scopes before enqueue and
queues only the daily window with five attempts. The handler reloads the full
boundary, rejects substituted account/Region scope before provider I/O, leases
a deterministic tenant/connection/window replay key, verifies completed-result
SHA-256 before replay, and seals successful results. Immutable generations are
content-addressed. Only `READY` evidence can become the head, and the head
advances only to a later collection.

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

1. Implement the credential-owning signed bounded multi-account/Region provider adapter.
2. Register the scheduler/handler with a permanent replay store and deploy and attest least-privilege policies.
3. Validate calendar/version mappings, normalized OpenSearch factors,
   ElastiCache premiums and Region/date-specific rates against live AWS.
4. Validate real CUR2 charges, corrections, currencies, missing inputs,
   enrollment/version changes and complete-empty cases.
5. Complete adversarial, signed-in accessibility and production acceptance.
6. Move monetary provider fields to signed decimal/micro strings before
   claiming end-to-end exact-money ingestion.

Until these gates pass, ADV-04 is not `LOCAL_VERIFIED` or `LIVE_VERIFIED`.

Focused local result: **20 passed, 0 failed, 0 skipped** across the projection,
runtime, repository, API and server-rendered UI suites; focused ESLint and diff
checks passed. Full exact-tree type/build/security validation remains G7 after
all concurrent dashboard work is integrated.

The report-independent null/configuration rendering contract is additionally
covered by `tests/finops-report-independent-official-ui.test.mjs`.
