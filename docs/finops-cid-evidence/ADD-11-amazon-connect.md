# ADD-11 — Amazon Connect Cost Insights

## Status

`RUNTIME_BINDING_LOCAL` (not registered or deployed). The source engine now has
an identity-only daily scheduler contract, server-resolved Connect/CUR2/privacy
boundary, permission attestation, signed materializer verification, canonical
immutable evidence archive, sealed tenant reference, accepted-attempt replay,
immutable accepted-generation persistence, authenticated aggregate API and
native seven-area UI. The real provider adapter, runtime composition, IAM
deployment, HMAC key service, privileged contact approval/audit route and live
AWS evidence are not deployed.

## Implemented official areas

| Area | Evidence-honest implementation |
|---|---|
| Connect/contact-center overview | Selected CUR2 cost basis/currency, governed instance count, aggregate phone inventory, billing rows, unattributed cost and tokenized-contact count. |
| Contact-center account analysis | Tenant-authorized instance labels, state, voice configuration, observation time, aggregate phone count and Connect/telecom CUR2-attributed cost. Instance ARNs are not returned. The UI now explicitly says that the official CID supporting-AWS-service spend view is not yet present. |
| Connect voice usage/cost | Voice channel rows by day, direction, charge family, usage type, source unit and signed exact cost micros. |
| Telecom by number type/country | CUR2 telecom aggregates plus pre-broker phone-inventory counts by country/type/status. No telephone values are retained. |
| Thirty-day daily cost/usage | A fixed 30-day window ending at CUR2 `dataThroughAt`, preserving inbound/outbound direction, phone-number charges, usage type and unlike units. |
| Call patterns/durations/regions | Aggregated channel/direction/country/number-type/contact-count/cost/quantity views. Country is explicitly not caller location, and usage quantity is not asserted to be conversation duration unless its CUR unit proves that meaning. |
| Privacy-safe contact search/details | Ordinary UI filters aggregated token-count patterns only. Raw contact IDs, phone numbers, endpoints, caller identity and HMAC tokens are never returned. Exact token lookup remains disabled pending a separate audited approval/grant route. |

## Durable chain

- Engine: `lib/finops-amazon-connect-cost-insight.ts`
- Materialization job: `lib/finops-amazon-connect-cost-insight-job.ts`
- Durable runtime boundary: `lib/finops-amazon-connect-cost-insight-runtime-binding.ts`
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

The durable runtime queues only organization/customer/connection identity and
a UTC day. Each attempt resolves the exact account, partition, Region and
sorted authorized instance ARNs; active reconciled CUR2 generation, source
evidence, manifest, data-through time, cost basis, currency, row-exhaustion,
resource-ID/tag coverage and versioned Connect/telecom classifier; permission
attestation; and HMAC key version from trusted server state.

The signed request requires `TargetArn` for every `ListPhoneNumbersV2` sequence,
forbids unscoped listing and traffic-distribution-group expansion, pins a
1,000-record page size and pagination-token replay rejection, and requires
per-instance exhaustion evidence. It carries only the three exact read actions,
exact instance resources, the documented phone-number wildcard resource, the
Directory Service `*` dependency, immutable CUR2 lineage, engine bounds and a
15-minute abort deadline. It accepts no raw phone values/ARNs/IDs, descriptions,
contact records, caller identities, endpoint addresses, directory details or
provider error text.

The exact boundary, request, verification and normalized-safe capture are
canonically archived as `finops_source_snapshot`, assigned a deterministic
`fss_` generation, and sealed with organization/customer/connection/source/
generation context. Accepted retries verify the `acig_` snapshot and evidence
lineage and perform no second provider read, archive or commit. Scope,
permission-resource, signature, CUR2 generation/manifest, token-key, archive
hash and sealed-reference substitutions fail closed with generic codes.

## Privacy boundary

The standard API requires an authenticated session, organization-owned active
AWS connection and same-customer `connection:read` capability. Its response
contains governed instance aliases and aggregate billing/configuration facts,
but no instance ARN, phone value, raw contact ID, endpoint, HMAC token, caller
identity, agent identity, recording or transcript. The job contract pins the
three exact reads, active CUR2 generation, duration/concurrency/row bounds, and
false-valued raw-data acceptance flags.

## Official parity boundary

AWS currently documents seven tabs: Overview, Contact Center Analysis,
Connect, Telecom Spend, Daily Usage, Call Details and Contact Search. AWS also
describes Contact Center Analysis as supporting-service consumption in accounts
running Connect, excluding Connect costs. The current Sutra v1 row schema is
deliberately limited to `AMAZON_CONNECT` and `CONTACT_CENTER_TELECOM`, so it
must not claim that broader view. The runtime pins
`associatedServiceCoverage=NOT_INCLUDED_SEPARATE_EVIDENCE_REQUIRED`, and the UI
discloses the gap. Closing it requires a separately normalized CUR2 evidence
plane for all supporting AWS services in the governed Connect-enabled account
set, with its own completeness and attribution semantics.

The official sources also state that granular billing uses activated contact
cost-allocation tags and optional resource IDs, and that resource IDs can make
CUR substantially larger. This is why the runtime retains explicit tag and
resource-ID coverage, byte/row bounds and tokenization lineage instead of
assuming contact-level completeness.

## Remaining live gates

1. Implement the server boundary loader, signed materializer, immutable archive
   and sealer, transactional accepted-attempt handoff, and HMAC key resolver.
2. Register the daily job/handler and replace the API's legacy adapter reason
   only after the complete runtime composition exists.
3. Deploy the attested three-action IAM contract and verify exact instance
   targets, `TargetArn` enforcement and wildcard-phone compensating controls.
4. Add the separate supporting-AWS-service CUR2 evidence plane needed for full
   official Contact Center Analysis parity; do not merge it with Connect spend.
5. Validate classification against real invoices and mixed units, currencies,
   taxes, credits, refunds, missing tags/resource IDs and high-volume billing.
6. Operate tenant HMAC key rotation/retention/destruction and prove tokens or
   raw provider fields cannot leak through logs, errors, caches or exports.
7. If exact token lookup is approved, implement a separate policy approval,
   immutable audit event and expiring grant route; do not extend ordinary
   `connection:read` access.
8. Apply the already-registered SQLite/PostgreSQL migrations in the staged
   release and verify immutable-head guards before provider activation.
9. Complete live cross-tenant/account/Region/instance, stale, throttled,
   pagination, unsupported-region and signed-in accessibility tests.

Until these gates pass, ADD-11 is not `LOCAL_VERIFIED` or `LIVE_VERIFIED`. The
runtime binding intentionally reports
`AMAZON_CONNECT_SERVER_PROVIDER_BOUNDARY_NOT_CONFIGURED` or
`AMAZON_CONNECT_SIGNED_MATERIALIZER_ADAPTER_NOT_DEPLOYED`, and its
`registeredInSharedRuntime` marker remains `false`.
