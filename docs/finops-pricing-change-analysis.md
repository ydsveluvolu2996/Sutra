# AWS Pricing Change Analysis evidence contract

Status: the pure normalization/repricing engine and focused tests are
implemented. Collector, durable persistence, authenticated API, dashboard UI,
and live AWS acceptance are not implemented by this slice.

## Capability boundary

`lib/finops-pricing-change-analysis.ts` models the AWS Cloud Intelligence
Dashboard use case: hold actual historical usage constant and compare the
public AWS catalog rates effective at two selected dates. AWS describes the
dashboard as isolating pricing-change impact by service, payer account, linked
account, and Region:

- [AWS Pricing Change Analysis Dashboard](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/pricing-change-dashboard.html)

The engine is a pure tenant trust boundary. It accepts no credentials, performs
no network or database I/O, caches no process-global tenant state, and does not
infer tenant identity from capture content. The caller supplies the exact
organization/customer/connection scope, AWS partition, payer accounts, linked
accounts, and Regions; the immutable capture must repeat that boundary.

The result is deliberately named `modeledChange`, not savings. It is a public
catalog what-if calculation and is **not** an invoice, forecast, quote,
discount calculation, commitment-benefit calculation, or savings claim. It
does not include private pricing, Enterprise Discount Program terms, credits,
taxes, support, refunds, Reserved Instance/Savings Plan benefit allocation, or
currency conversion. Those effects remain in the source billing evidence and
must not be reverse-engineered from this comparison.

## Active CUR 2.0 usage evidence

Every usage row is tied to the single server-selected active immutable CUR 2.0
generation and its manifest SHA-256. The capture includes successful/partial/
failed object coverage, permission attestation, and processed-versus-manifest
object counts. A complete zero-row generation yields `NO_USAGE`; a failed or
partial read never becomes a zero-usage claim. Generations more than 48 hours
old are reported as `STALE` and are not priced.

The required canonical CUR 2.0 fields include payer account, usage account,
product/service code, Region, usage start/end, line-item type, pricing term,
pricing unit, exact usage quantity, and the complete product/term applicability
attributes needed to join a public catalog dimension. AWS documents that CUR
2.0 has a consistent schema and inherits consolidated-billing organization
scope, while the line-item dictionary defines usage account, usage amount,
usage unit/rate, operation, product code, and line-item types:

- [CUR 2.0 table dictionary](https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-cur2.html)
- [CUR 2.0 line-item columns](https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-cur2-line-item.html)
- [CUR 2.0 pricing columns](https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-cur2-pricing.html)

Only usage quantities are re-priced. Observed CUR costs remain authoritative
billing evidence elsewhere; the engine does not claim that public catalog
price multiplied by usage should reconcile to the invoice.

## Versioned AWS pricing evidence

The collector must call `ListPriceLists` separately for the baseline and
comparison effective timestamps and for each exact service, currency, and
Region. AWS documents that `EffectiveDate` selects historical price-list
references and that the returned `PriceListArn` is passed to
`GetPriceListFileUrl`:

- [ListPriceLists API](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_pricing_ListPriceLists.html)
- [AWS Price List Bulk API workflow](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api.html)
- [Reading AWS Price List files](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/reading-an-offer.html)

Each accepted snapshot preserves:

- baseline/comparison role and requested effective timestamp;
- AWS partition, service code, Region, and ISO currency;
- exact Price List ARN, catalog version, publication timestamp, and effective
  timestamp;
- hashes and retrieval timestamps for both the `ListPriceLists` response and
  downloaded JSON file;
- product SKU, offer term, rate code, usage unit, term type, applicability
  attributes, price interval, tier range, and exact price rational.

Price files retrieved more than 31 days before the capture are retained as
audit evidence but suppress modeling until refreshed. A historical catalog can
have an old effective/publication date without being stale; staleness applies
to the evidence retrieval, not the historical date being analyzed.

## Exact applicability and arithmetic

A usage row references explicit baseline and comparison price IDs. The engine
does not fuzzy-match descriptions or guess product equivalence. Both catalog
terms must match the row's service, Region, currency, unit, term type, and
sorted product/term applicability attributes, and each term must be effective
at its analysis timestamp.

The v1 engine automatically models only flat price dimensions whose tier range
is `[0, Inf)`. A tiered dimension produces
`TIERED_RATE_REQUIRES_ALLOCATION_EVIDENCE`; it never applies the first or last
tier to all usage. A later collector may provide an explicit AWS-evidenced tier
allocation contract before tiered modeling is enabled.

Usage quantities and unit prices are canonical reduced decimal rationals.
Calculations use `bigint` numerator/denominator multiplication and aggregation;
binary floating point is never used. Results retain the exact rational.
`roundedMicros` is a display projection using half-away-from-zero rounding
after aggregation, so per-line rounding cannot accumulate into the comparison.
Currency is never converted or totaled across ISO currencies. Output groups
keep service, payer, linked account, Region, currency, unit, and term type
separate.

## Read-only IAM contract

The minimum AWS Price List reads for the versioned bulk-file path are:

```text
pricing:ListPriceLists
pricing:GetPriceListFileUrl
```

The [AWS Price List service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_awspricelist.html)
states that AWS Price List does not support resource-level ARN restrictions or
service-specific condition keys. Therefore these two actions require
`Resource: "*"`. They belong in the permanent read-only collector policy and
broker attestation. No create, update, or delete permission is required.

`pricing:DescribeServices` is optional discovery when the collector does not
already have a server-pinned service-code set; `pricing:GetAttributeValues` is
optional Region/attribute discovery. Neither is required by this engine's
versioned bulk-file contract. `pricing:GetProducts` is not required because the
bulk files are authoritative inputs. If discovery is enabled later, all three
additional Price List reads also require `Resource: "*"`.

CUR 2.0 S3 reads remain restricted to the exact tenant export bucket/prefix
through the existing broker contract. The engine does not broaden that policy.

## Honest states and bounds

The response state is one of:

- `READY`: every input usage row was modeled from complete, fresh evidence;
- `PARTIAL`: at least one row was modeled and at least one was excluded;
- `CONFIGURATION_REQUIRED`: usage exists but no row can be modeled because
  required source, mapping, permission, or applicability evidence is absent;
- `STALE`: all rows are suppressed only because the active generation or
  catalog retrieval is stale;
- `NO_USAGE`: complete active CUR 2.0 evidence contains zero usage rows.

Every exclusion is aggregated by a bounded machine-safe reason plus service,
payer, linked account, Region, unit, and term. Raw AWS/provider errors are not
accepted or returned.

The v1 contract enforces a 64 MiB capture, 8 MiB response, 15-minute capture,
1,000 payer/linked accounts, 50 Regions, 250,000 usage rows, 20,000 catalog
snapshots, 500,000 catalog terms, 5,000 modeled output groups, 2,000 exclusion
groups, a 400-day usage window, canonical UTC timestamps, strict object keys,
sorted unique scopes/attributes, SHA-256 evidence identities, and generic
client-safe errors.

## Remaining production gates

1. Add timeout- and page-bounded `ListPriceLists` and
   `GetPriceListFileUrl` collection through the authenticated AWS broker; hash
   the exact responses/files before parsing and never pass credentials to the
   web process.
2. Add the two Pricing reads with `Resource: "*"` to the versioned collector
   policy and exact broker attestation. This slice intentionally does not
   change the central permission plan.
3. Build the CUR 2.0-to-catalog applicability adapter, including an explicit
   product/term mapping coverage report and tier-allocation evidence for any
   non-flat price dimension.
4. Persist immutable pricing snapshots/terms, active CUR generation IDs,
   source hashes, comparison captures, and active heads under exact
   organization/customer/connection scope.
5. Add an authenticated tenant-scoped route and professional dashboard views
   for service, payer, linked account, Region, effective-date timeline,
   increases/decreases, exclusions, coverage, and source evidence.
6. Run live tests in an approved AWS account against at least two known
   historical catalog versions; independently reproduce rational totals, test
   stale/partial/no-usage/tier/cross-currency states, and retain signed
   acceptance evidence before production activation.

