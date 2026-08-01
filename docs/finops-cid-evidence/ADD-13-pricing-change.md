# ADD-13 — Pricing Change Analysis Dashboard

Reviewed: **2026-08-01** against AWS Guidance and immutable AWS CID framework
commit `f9e36d88c47709f10e8fa784ad11d5cc0e728021`.

Status: **PARTIAL_PIPELINE**. A bounded exact-arithmetic engine, server-owned
CUR2-to-catalog materialization job, immutable sealed-evidence metadata
repository, authenticated same-tenant read API, and native responsive dashboard
view now exist locally. The historical AWS Price List provider adapter, durable
job-handler registration, live AWS acceptance, and production activation remain
open.

## Official capability audit

AWS describes the Pricing Change Analysis Dashboard as applying pricing changes
to actual usage and isolating the impact by service, payer account, linked
account, and Region:

- [Pricing Change Analysis Dashboard — AWS Cloud Intelligence Dashboards](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/pricing-change-dashboard.html)

AWS documents the historical bulk-file workflow as `ListPriceLists` followed by
`GetPriceListFileUrl`, with service, currency, Region, and effective-date inputs:

- [Getting price list files using the AWS Price List Bulk API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api.html)
- [Reading AWS Price List files](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/bulk-api-reading-price-list-files.html)
- [Service price list file structure](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/reading-service-price-list-file-for-services.html)

AWS also states that Price List API data is informational and that the service
pricing page controls if it differs. Sutra therefore labels every result a
public-catalog what-if and never an invoice, quote, forecast, discount, or
savings claim:

- [Calling AWS services and prices using AWS Price List](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html)

### Pinned public artifact inventory

The pinned AWS CID framework publishes the complete QuickSight definition as a
decoded YAML block scalar inside `dashboards/pca/pca.yaml`. It also embeds the
SPICE dataset template and Athena view query, publishes a PCA changelog, and
uses the shared CID plugin CloudFormation template. No standalone definition or
dashboard-specific deployment template exists at this commit.

| Published artifact | Pinned path / hash basis | SHA-256 |
|---|---|---|
| Manifest container | `dashboards/pca/pca.yaml`, raw bytes | `2919c040bd1913eddac949bfcf5aceb2df14b2e2d0dd28a9e3f399001dfa2ae8` |
| Embedded QuickSight definition | `dashboards.PRICING CHANGE ANALYSIS.data`, exact decoded scalar bytes | `b8f3c3579f4c7fe9163b5b1a4399c8ca7e40c70ed0155c9312f95eacdfca40fd` |
| Embedded SPICE dataset template | `datasets.pricing_changes.data`, recursively key-sorted canonical JSON | `dbf76e59436e60a4b855cace840d9c8823972b53ee344494b86aefab97fa3af4` |
| Embedded Athena view | `views.pricing_changes.data`, exact decoded scalar bytes | `d8aa257b9655f94c2112042e57587914a7dceeb38b664209bb7591709634540f` |
| PCA changelog | `changes/CHANGELOG-pca.md`, raw bytes | `8ef9302aa2f33a190c6ef84d7f069c79e99afb730cc25dd287e56193ca3122f8` |
| Shared deployment template | `cfn-templates/cid-plugin.yml`, raw bytes | `b96a47e6b53418293ec7127d0a95f96f2ffdae2781cde2b2dffcabad926a713d` |

Current AWS Guidance lists this dashboard as **Additional**, while the pinned
manifest labels it `ADVANCED`. The manifest identifies dashboard version
`v1.1.0`; the separate public changelog currently says `v1.0.1`. All four
source values are retained without inventing a reconciliation.

### Exact published QuickSight inventory

| Sheet | Visual inventory | Control placements |
|---|---|---|
| Pricing Change Analysis | 10: 4 bar, 2 KPI, 1 line, 1 combo, 2 pivot | 1 parameter + 5 filter |
| About | 1 insight (`Notices`) | 4 repeated cross-sheet filters |
| **Total** | **2 sheets / 11 visuals** | **1 parameter + 9 filter = 10 placements** |

The definition also proves 6 parameter declarations, 10 calculated fields, 8
filter groups, 3 column configurations, and 1 dataset declaration. The SPICE
dataset joins a 21-column `pricing_changes` physical table to the 2-column
`account_map`, projects 25 logical columns, and depends on the embedded
121-line Athena view and the shared account map.

The exact main-sheet purposes are: Region and impacted-service-SKU cost
difference; account-name and service impact; last-month difference; monthly
pre/post-change cost; monthly payer/account drilldown; payer impact; service
impact; two-months-ago difference; service/month summary; and SKU/rate-change
detail. The published controls are Cost Type, Service Name, Linked Account
Name, Linked Account ID, Payer Account ID, and Date Range. Sutra maps only
service, linked-account ID and payer filters as supported; Date Range remains
server-pinned, and friendly account name and Cost Type remain unavailable.

These are exact definition objects, not claims of pixel or interaction parity.
The upstream query detects historical billed-rate changes from CUR, whereas the
unfinished Sutra engine compares two version-pinned public Price List files
against held-constant CUR2 usage. Those methods are intentionally not presented
as equivalent.

## Implemented local slice

- `lib/finops-pricing-change-analysis.ts` validates exact tenant scope,
  version-pinned catalog evidence, source coverage, term/product applicability,
  effective intervals, currency, units, tier bounds, and exact rational
  arithmetic. It never fuzzy-matches products or combines currencies.
- `lib/finops-pricing-change-materialization-job.ts` resolves an identity-only
  durable job through a server-owned comparison policy, requires one active
  reconciled canonical CUR2 `fbg_` generation, freezes its payer/account/Region
  boundary, requests only historical Price List bulk files, reruns the engine,
  archives the canonical capture, seals its managed object reference, and
  persists immutable metadata. Missing policy, CUR2, or provider adapter states
  return explicit unavailable reasons and never fabricate a zero-impact result.
  It also owns the permanent daily scheduler contract: every eligible server
  policy is prevalidated before enqueue, idempotency includes the complete
  organization/customer/connection/policy/window tuple, jobs have exactly five
  attempts, and the shared-runner adapter treats unavailable activation as a
  failed job instead of silently completing it.
- `drizzle/0088_finops_pricing_change_materializations.sql` and
  `postgres/migrations/0083_finops_pricing_change_materializations.sql` add
  append-only lineage/count metadata and complete-only monotonic active heads.
  Raw CUR usage and catalog terms are deliberately absent from SQL.
- `db/finops-pricing-change-repository.ts` binds every read/write to the live
  organization, customer, and AWS trust-role connection. It stores only a
  sealed `fss_` evidence reference, content hash, bounded counts, and dates.
- `app/api/v1/finops/pricing-change-analysis/route.ts` requires an authenticated
  session, resolves the connection inside the session organization, checks
  `connection:read`, opens the evidence pointer with full
  organization/customer/connection/source/generation AAD, independently reads
  the hash-bound managed object, and reruns the engine before returning values.
  Every successful response state also includes the frozen official-source
  definition audit.
- `app/costs/finops-pricing-change-dashboard.tsx` and its dedicated CSS module
  provide complete/configuration/waiting/partial/stale/failed/empty states,
  service/payer/linked-account/Region/currency/direction filters, per-currency
  baseline/comparison visuals, exact group drilldown, exclusions, and immutable
  Price List/CUR lineage. The report-independent official-source panel renders
  the exact artifacts, sheets, visual purposes, control placements and gaps in
  both report-ready and report-null states. `bigint` is retained for monetary
  display and bar proportions.
- `lib/finops-pricing-change-official-definition.ts` freezes the pinned hashes,
  exact object inventory, dataset/query boundaries, source-proven titles, and
  per-purpose native coverage without filling unpublished or unavailable
  behavior with zero.

## Evidence and privacy boundary

The persisted evidence body contract is:

```text
sutra.pricing-change.capture-evidence.v1
  boundary: server-selected tenant/account/Region boundary
  capture: validated immutable CUR2 + versioned Price List input
```

The body must be archived as an `application/json` managed
`finops_source_snapshot` object under an `fss_` evidence generation. The SQL
materialization retains only the sealed object identifier, SHA-256, evidence
generation, source/effective timestamps, state, and bounded counts. A read is
rejected if any tenant dimension, source ID, generation ID, object hash,
retention state, materialization identity, or engine scope differs.

Only engine `READY` and evidence-complete `NO_USAGE` materializations can
advance the active head. Partial, stale, and configuration-required captures
remain immutable history. A later incomplete generation cannot replace an
accepted complete generation.

## Honest state contract

| API state | Meaning |
|---|---|
| `configuration_required` | No persisted server-owned capture is available. |
| `waiting` | A durable pricing source attempt is queued or running. |
| `partial` | Some exact mappings are unavailable or the latest attempt is partial. |
| `stale` | CUR2 or catalog retrieval freshness suppresses current modeling. |
| `failed` | The latest attempt failed or retained evidence cannot be rebound and validated. |
| `empty` | Complete accepted source evidence contains zero usage rows. |
| `complete` | Every input usage row has an exact applicable baseline and comparison rate. |

No state treats missing delivery as zero usage or zero impact.

## Focused verification

- Domain engine: `tests/finops-pricing-change-analysis.test.ts`
- Materializer orchestration, exact-money preservation, unavailable states,
  mismatch denial, and at-least-once replay:
  `tests/finops-pricing-change-materialization-job.test.ts`
- Migration parity/guard contract:
  `tests/finops-pricing-change-migration-contract.test.mjs`
- Same-tenant persistence, replay, head monotonicity, and immutability:
  `tests/finops-pricing-change-repository.test.mjs`
- Authenticated route, evidence rebinding, state/UI contract, responsive CSS,
  and actual SSR content:
  `tests/finops-pricing-change-route-ui-contract.test.mjs`
- Pinned artifacts, exact QuickSight totals, source-proven purposes and dataset
  boundaries: `tests/finops-pricing-change-official-definition.test.ts`

## Remaining production gates

1. Register the existing durable handler for
   `finops-pricing-change-materialize`, its daily scheduler, and its server
   policy and active-CUR2 loaders. The existing billing repository is
   authoritative, but a bounded materializer reader must page the complete
   selected `fbg_` generation rather than using its 1,000-row UI query ceiling.
2. Implement and register the timeout/page/byte-bounded authenticated AWS
   adapter for historical `pricing:ListPriceLists` and
   `pricing:GetPriceListFileUrl` JSON files. No adapter is currently claimed.
3. Build and provider-verify the complete CUR2 product/term applicability map,
   including explicit tier allocation evidence. Unmapped or tier-ambiguous rows
   must remain exclusions.
4. Run controlled AWS acceptance against at least two known historical catalog
   versions, independently reproduce totals, prove cross-tenant denial, retain
   signed evidence, and pass exact-image rollback/post-deploy gates.

Until these gates pass, activation is deliberately returned as
`available: false` with
`AWS_HISTORICAL_PRICE_LIST_MATERIALIZER_NOT_REGISTERED`, and ADD-13 must not be
marked local-verified, live-accepted, or production-ready.
