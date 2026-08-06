# ADD-11 — Amazon Connect Cost Insights

## Status

`RUNTIME_BINDING_LOCAL` (not registered or deployed). The source engine now has
an identity-only daily scheduler contract, server-resolved Connect/CUR2/privacy
boundary, permission attestation, signed materializer verification, canonical
immutable evidence archive, sealed tenant reference, accepted-attempt replay,
immutable accepted-generation persistence, authenticated aggregate API and
native seven-area UI. A complete pinned AWS QuickSight definition audit is now
returned in every successful API state and rendered with ready or missing data.
The real provider adapter, runtime composition, IAM
deployment, HMAC key service, privileged contact approval/audit route and live
AWS evidence are not deployed.

## Pinned official-source audit

Reviewed `2026-08-01` against current AWS Guidance and immutable AWS CID commit
`f9e36d88c47709f10e8fa784ad11d5cc0e728021`.

AWS publishes the complete QuickSight `AnalysisDefinition` inline in
`dashboards/amazon-connect/amazon-connect.yaml`. Exact structural counts are
therefore provable: **8 sheets, 121 visuals, 47 parameter-control placements,
14 filter-control placements, 18 parameter declarations, 33 calculated fields,
157 filter groups, 8 column configurations and 2 dataset declarations**. These
are source-definition counts, not a claim of pixel, geometry, query-result or
interaction parity.

| Public artifact | SHA-256 |
|---|---|
| `dashboards/amazon-connect/amazon-connect.yaml` | `dc39d46a29881b54384ff57feee193f23fa23bd6631cc3dda39352cd2960cbea` |
| Embedded QuickSight definition | `c5078f8b73558a7ab1bc388e24dd52fae0ddd954f5097aec8e50b6552fdfc0b8` |
| `changes/CHANGELOG-amazon-connect.md` | `147cab6cc9d5e2e95126ea39ae1b3df8efbee3b880788daef4114e6ca14383b2` |
| Public shared `summary_view` dataset definition | `8e509103b770e7deb220a04eba63703c47db3142f08033bbb70c93498acc3ab8` |
| Public shared `summary_view` SQL | `57b8ab6ec7d22e0bd642c1bbe44f5bc5cc2cce8523ef0c795ce410a1ae3dec8e` |

The changelog's latest pinned entry is `v1.1.1`. No separate definition file,
standalone template body, external template ID or dashboard-specific deployment
template is published; those paths remain `null`. Of the two declared datasets,
the shared `summary_view` body and SQL are public and hash-pinned (50 unique
input columns). The `resource_connect_view` identifier and field references are
visible inside the dashboard definition, but its dataset body and producing
query are not committed at this revision; all of their artifact paths, hashes
and input-column totals remain `null` rather than zero.

The embedded inventory proves these per-sheet totals:

| Sheet | Visuals | Parameter controls | Filter controls | AWS-documented purpose mapping |
|---|---:|---:|---:|---|
| Overview | 16 | 9 | 0 | High-level Amazon Connect and Contact Center Telecom charges. |
| Contact Center | 8 | 7 | 0 | Accounts running Connect and associated contact-center services; native supporting-service coverage remains unavailable. |
| Connect | 23 | 7 | 0 | Connect Voice usage and cost; native evidence is partial. |
| Telecom | 17 | 8 | 4 | Telecom cost by number type and country; native evidence is partial and retains no telephone values. |
| Daily Usage | 27 | 6 | 0 | Thirty-day cost/usage trends and inbound/outbound/phone-number usage; native evidence is partial. |
| Call Details | 22 | 5 | 4 | Call patterns, durations and regional distribution; native billing country and source-unit semantics are explicitly narrower. |
| Contact Search | 7 | 5 | 6 | Individual-contact analysis; native ordinary access is deliberately privacy-safe aggregate-only. |
| About | 1 | 0 | 0 | Additional source-defined sheet; AWS Guidance enumerates seven analytical tabs, so no eighth analytical purpose is invented. |

The frozen contract is
`lib/finops-amazon-connect-official-definition.ts`. The API returns it in both
configuration-required and report-bearing HTTP 200 responses. The native UI
validates the pinned schema, commit and embedded-definition hash before
rendering it in both states.

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
  `tests/finops-amazon-connect-cost-insights-vertical.test.mjs`, plus
  `tests/finops-amazon-connect-official-definition.test.ts`

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
  (PR #37).** This row's own view module was not modified; it was already on
  the native chart kit before these merges. What reached it is shared:
  `app/costs/finops-foundational-panels.tsx` and
  `app/costs/finops-cur-intelligence-panels.tsx` stopped drawing an absent
  series as a floored zero (`tests/finops-shared-panel-floors.test.mjs`), which
  preserves the absent-is-not-zero release invariant in the panels this row
  renders. Across `app/costs/`, 28 view modules plus the catalog page now import the kit,
  and the kit's own rendering suite `tests/chart-kit-rendering.test.mjs` holds
  12 tests. `app/costs/finops-dashboard-identity.tsx` renders each dashboard's
  catalog glyph, name and ID above every opened view
  (`tests/finops-dashboard-identity.test.mjs`). This is UI rendering work only:
  no source contract, collector operation, migration, API shape, or evidence
  semantic changed, and no G5 or G6 stage status is promoted by it.

- **Corrected defect: undeclared lazily loaded AWS SDK client — `92a0084`
  (PR #41).** `services/aws-collector/src/amazon-connect-cost-provider-client.ts` resolves
  `@aws-sdk/client-connect` through `import(<string variable>)`, so the
  dependency was invisible to static resolution: it was declared in no manifest
  and absent from `node_modules`. **The provider adapter for ADD-11 Amazon Connect Cost Insights could not have
  executed before `92a0084` — the first real run would have failed with
  `ERR_MODULE_NOT_FOUND`.** The client is now pinned at `3.1087.0` in
  `services/aws-collector/package.json` with `pnpm-lock.yaml` updated, and
  `services/aws-collector/test/lazy-sdk-dependencies.test.ts` scans shipped
  collector source for `@aws-sdk` literals and fails when one is undeclared.
  This corrects a latent defect in previously recorded work. It adds no
  capability and is not provider evidence: the adapter still has never been run
  against AWS, so G1/G2 remain exactly as stated above.
