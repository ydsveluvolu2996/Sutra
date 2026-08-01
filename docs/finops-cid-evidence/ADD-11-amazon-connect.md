# ADD-11 — Amazon Connect Cost Insights

## Status

`PARTIAL_PIPELINE`. The source engine, permanent materialization contract,
immutable accepted-generation persistence, authenticated aggregate API and
native seven-area UI are implemented and locally focused-tested. The provider
adapter, scheduled job binding, IAM deployment, HMAC key service, privileged
contact approval/audit route and live AWS evidence are not deployed.

## Implemented official areas

| Area | Evidence-honest implementation |
|---|---|
| Connect/contact-center overview | Selected CUR2 cost basis/currency, governed instance count, aggregate phone inventory, billing rows, unattributed cost and tokenized-contact count. |
| Contact-center account analysis | Tenant-authorized instance labels, state, voice configuration, observation time, aggregate phone count and CUR2-attributed cost. Instance ARNs are not returned. |
| Connect voice usage/cost | Voice channel rows by day, direction, charge family, usage type, source unit and signed exact cost micros. |
| Telecom by number type/country | CUR2 telecom aggregates plus pre-broker phone-inventory counts by country/type/status. No telephone values are retained. |
| Thirty-day daily cost/usage | A fixed 30-day window ending at CUR2 `dataThroughAt`, preserving inbound/outbound direction, phone-number charges, usage type and unlike units. |
| Call patterns/durations/regions | Aggregated channel/direction/country/number-type/contact-count/cost/quantity views. Country is explicitly not caller location, and usage quantity is not asserted to be conversation duration unless its CUR unit proves that meaning. |
| Privacy-safe contact search/details | Ordinary UI filters aggregated token-count patterns only. Raw contact IDs, phone numbers, endpoints, caller identity and HMAC tokens are never returned. Exact token lookup remains disabled pending a separate audited approval/grant route. |

## Durable chain

- Engine: `lib/finops-amazon-connect-cost-insight.ts`
- Materialization job: `lib/finops-amazon-connect-cost-insight-job.ts`
- SQLite: `drizzle/0100_finops_amazon_connect_cost_insights.sql`
- PostgreSQL: `postgres/migrations/0095_finops_amazon_connect_cost_insights.sql`
- Repository: `db/finops-amazon-connect-cost-insight-repository.ts`
- API: `app/api/v1/finops/amazon-connect-cost-insights/route.ts`
- UI: `app/costs/finops-amazon-connect-cost-insights-dashboard.tsx`
- Tests: `tests/finops-amazon-connect-cost-insight.test.ts` and
  `tests/finops-amazon-connect-cost-insights-vertical.test.mjs`

Snapshots are normalized before persistence, content-addressed, immutable and
tenant/account/partition/Region/instance scoped. Only `complete` generations
can become the head, and a head advances only to a later completion timestamp.
Incomplete corrections remain immutable history.

## Privacy boundary

The standard API requires an authenticated session, organization-owned active
AWS connection and same-customer `connection:read` capability. Its response
contains governed instance aliases and aggregate billing/configuration facts,
but no instance ARN, phone value, raw contact ID, endpoint, HMAC token, caller
identity, agent identity, recording or transcript. The job contract pins the
three exact reads, active CUR2 generation, duration/concurrency/row bounds, and
false-valued raw-data acceptance flags.

## Remaining live gates

1. Deploy the signed/replay-resistant provider adapter and scheduler with the
   exact authorized instance boundary and permission attestation.
2. Validate classification against real invoices and mixed units, currencies,
   taxes, credits, refunds, missing tags/resource IDs and high-volume billing.
3. Operate tenant HMAC key rotation/retention/destruction and prove tokens or
   raw provider fields cannot leak through logs, errors, caches or exports.
4. If exact token lookup is approved, implement a separate policy approval,
   immutable audit event and expiring grant route; do not extend ordinary
   `connection:read` access.
5. Complete live cross-tenant/account/Region/instance, stale, throttled,
   pagination, unsupported-region and signed-in accessibility tests.

Until these gates pass, ADD-11 is not `LOCAL_VERIFIED` or `LIVE_VERIFIED`.
