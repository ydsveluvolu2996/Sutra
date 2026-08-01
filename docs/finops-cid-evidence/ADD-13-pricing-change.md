# ADD-13 — Pricing Change Analysis Dashboard

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
- `app/costs/finops-pricing-change-dashboard.tsx` and its dedicated CSS module
  provide complete/configuration/waiting/partial/stale/failed/empty states,
  service/payer/linked-account/Region/currency/direction filters, per-currency
  baseline/comparison visuals, exact group drilldown, exclusions, and immutable
  Price List/CUR lineage. `bigint` is retained for monetary display and bar
  proportions.

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

## Remaining production gates

1. Register a durable handler for `finops-pricing-change-materialize` and bind
   its server policy and active-CUR2 loaders. The existing billing repository is
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
