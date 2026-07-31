# Sustainability Proxy Metrics and Carbon Emissions source contract

This slice defines Sutra's pure, tenant-scoped source and projection contract
for the AWS Cloud Intelligence Sustainability Proxy Metrics and Carbon
Emissions capability. It deliberately keeps two different evidence planes
separate:

1. resource-efficiency proxy metrics derived from exact usage quantities in an
   immutable active CUR2 generation; and
2. carbon estimates published by AWS in the `CARBON_EMISSIONS` Data Export.

The engine performs no AWS calls, S3 reads, persistence, route, or UI work. A
credential-owning collector must emit the bounded schema through Sutra's
authenticated broker. The caller supplies the trusted organization, customer,
connection, payer account, AWS partition, and allowed usage-account set; none
of those values may come from a browser selector.

The AWS dashboard guidance describes vCPU hours, storage usage, and data
transfer as proxy metrics and uses the separate carbon data export for provider
emissions:

- <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/sustainability-proxy-metrics-dashboard.html>
- <https://aws.amazon.com/blogs/aws-cloud-financial-management/measure-and-track-cloud-efficiency-with-sustainability-proxy-metrics-part-i-what-are-proxy-metrics/>
- <https://aws.amazon.com/blogs/aws-cloud-financial-management/measure-and-track-cloud-efficiency-with-sustainability-proxy-metrics-part-ii-establish-a-metrics-pipeline/>

## Current AWS service boundary

AWS deprecated the legacy Customer Carbon Footprint Tool on June 30, 2026 in
favor of AWS Sustainability. Sutra therefore labels current evidence as AWS
Sustainability evidence while retaining the Data Exports permission name AWS
still documents for the `CARBON_EMISSIONS` table. The source contract does not
scrape either console.

- <https://docs.aws.amazon.com/ccft/latest/releasenotes/what-is-ccftrn.html>
- <https://docs.aws.amazon.com/sustainability/latest/userguide/what-is-sustainability.html>
- <https://docs.aws.amazon.com/sustainability/latest/userguide/getting-started.html>

AWS Sustainability supports programmatic access through its API or through a
recurring S3 Data Export. This v1 slice ingests the S3 export because it gives
immutable object, schema, model-version, and publication lineage suitable for
Sutra's evidence store. The direct API is documented as an optional future
adapter, not silently mixed into an export generation.

- <https://docs.aws.amazon.com/sustainability/latest/userguide/bulk-data.html>
- <https://docs.aws.amazon.com/sustainability/latest/APIReference/API_GetEstimatedCarbonEmissions.html>

## Exact permissions and role separation

### Permanent collection role

After a provisioner creates the export, the permanent Sutra collector needs
only the already established exact-prefix S3 read surface:

- `s3:GetBucketLocation` on the configured export bucket;
- `s3:ListBucket` restricted to the exact tenant/export prefix;
- `s3:GetObject` (and `s3:GetObjectVersion` when object version IDs are used)
  restricted to that exact prefix.

The normalized evidence records the exact bucket, prefix, object key, ETag,
optional VersionId, size, SHA-256, generation ID, and manifest SHA-256. Every
object must remain inside the server-owned binding. The permanent role needs no
Data Exports mutation and no general Sustainability console access.

### One-time export provisioner

AWS documents this additional read permission to access/create a carbon
emissions export:

- `sustainability:GetCarbonFootprintSummary`

AWS Sustainability does not support resource ARNs or service-specific condition
keys for this action, so its IAM statement uses `Resource: "*"`. It belongs in
the separately approved export-provisioning session, along with the exact Data
Exports create/get/update/delete and S3 bucket-policy operations required by
the chosen infrastructure workflow. It is not a reason to broaden the normal
collector.

- <https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-carbon-emissions.html>
- <https://docs.aws.amazon.com/cur/latest/userguide/dataexports-create-standard.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_sustainability.html>

### Optional current AWS Sustainability API adapter

If a later adapter uses the current API instead of S3, its read-only surface is:

- `sustainability:GetEstimatedCarbonEmissions`
- `sustainability:GetEstimatedCarbonEmissionsDimensionValues`

Both require `Resource: "*"` because AWS Sustainability defines no resource
types or service-specific condition keys. The current API groups only by
`USAGE_ACCOUNT_ID`, `REGION`, and `SERVICE`; its supported emission values are
total LBM, total MBM, Scope 1, Scope 2 LBM/MBM, and Scope 3 LBM/MBM. That API
evidence must have its own generation and pagination lineage and must not be
merged into an S3 generation merely because dimensions look similar.

- <https://docs.aws.amazon.com/sustainability/latest/APIReference/API_GetEstimatedCarbonEmissions.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_sustainability.html>

## Provider carbon export contract

The SQL table name is exactly `CARBON_EMISSIONS`. Sutra v1 requires the complete
current 23-column table contract:

- publication: `last_refresh_timestamp`, `model_version`;
- payer and usage account: `payer_account_id`, `usage_account_id`;
- time: `usage_period_start`, `usage_period_end`;
- provider dimensions: `location`, `region_code`, `product_code`;
- totals: LBM value/unit and MBM value/unit;
- scopes: Scope 1 value/unit, Scope 2 LBM value/unit, Scope 2 MBM value/unit,
  Scope 3 LBM value/unit, and Scope 3 MBM value/unit.

The exact authoritative names, types, and nullability are here:

- <https://docs.aws.amazon.com/cur/latest/userguide/carbon-emissions-columns.html>

Sutra requires all columns so an older export cannot be presented as if it has
current Scope 1/2/3 and LBM/MBM coverage. The source values remain decimal
strings at AWS's documented Data Export resolution of `0.000001 MTCO2e` and are
converted only to integer micro-MTCO2e (grams) for exact arithmetic. The engine
never parses these values through JavaScript floating point. Nullable total LBM
or MBM fields remain null. Scope units must be exactly `MTCO2e`.

Each monthly period declares one selected model version and a delivery state of
`DELIVERED_ROWS` or `DELIVERED_EMPTY`. Rows must match the declared payer,
allowed usage-account set, exact calendar-month bounds, selected model version,
and commercial partition. An empty delivered file means AWS published no row
evidence for that partition; Sutra does not turn it into zero emissions.

AWS partitions exports by `model_version=Y/usage_period=YYYY-MM/`. Methodology
changes can recalculate history, so Sutra retains the model version and labels
each generation as monthly, backfill, or correction. A generation is complete
only when its exact objects and rows are exhausted and every expected month is
complete.

## Cadence, history, and organization coverage

AWS publishes Sustainability data monthly for the prior usage month, by the
21st day of the following month. The Data Exports delivery cadence is monthly;
AWS says export delivery can take up to 24 hours to start. Sutra uses a 35-day
publication freshness SLA for this source, rather than applying CUR2's 48-hour
SLA to monthly carbon data.

AWS provides history back to January 2022 (or account creation) and initially
delivers that history within 24 hours. Existing exports do not automatically
gain newly released columns. AWS documents support-case backfills and important
limitations when accounts or Organizations relationships change. Sutra's
expected-period list must therefore come from an operator-approved coverage
window; the engine does not assume that every month since 2022 exists.

For an AWS Organizations management account, the export can include the payer
and member accounts for the periods in which those accounts were linked. Member
accounts receive their own data only. A newly joined member may not appear
until the export period that includes its join. Sutra consequently validates
every record against a separate authenticated allowed-account set, but does not
claim that an absent account-month has zero emissions.

- <https://docs.aws.amazon.com/sustainability/latest/userguide/getting-started.html>
- <https://docs.aws.amazon.com/cur/latest/userguide/dataexports-create.html>
- <https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-carbon-emissions.html>
- <https://docs.aws.amazon.com/cur/latest/userguide/troubleshooting-carbon-emissions.html>

AWS documents carbon Data Exports in commercial AWS Regions. This contract
fails closed for `aws-cn` and `aws-us-gov`; it never implies unsupported
partition parity.

## LBM, MBM, scopes, and known estimate limitations

Location-based method (LBM) reflects average grid emissions intensity where
energy consumption occurs. Market-based method (MBM) reflects supplier-specific
intensity after instruments such as Energy Attribute Certificates. These are
different accounting methods and remain separate.

Scope 1 is direct emissions from owned or controlled sources. Scope 2 is
indirect emissions from purchased energy. Scope 3 is other value-chain
emissions. Sutra does not add LBM and MBM together and does not add total and
scope measures into a second total.

AWS says methodology versions evolve, historical data may be recalculated, and
monthly values can use estimates before later recasting to assured/invoiced
inputs. AWS also documents a display threshold: a reported zero can mean the
provider estimate is below `0.0000005 MTCO2e`. Sutra preserves an AWS-published
zero as provider evidence, but does not reinterpret it as proof of no impact.

- <https://docs.aws.amazon.com/sustainability/latest/userguide/console-visualizations.html>
- <https://docs.aws.amazon.com/sustainability/latest/userguide/methodology.html>
- <https://docs.aws.amazon.com/sustainability/latest/userguide/methodology-input-data.html>
- <https://docs.aws.amazon.com/cur/latest/userguide/troubleshooting-carbon-emissions.html>

## CUR2 proxy metrics

Proxy metrics are usage and efficiency indicators, not measured energy and not
carbon estimates. Sutra accepts only immutable active-CUR2 quantity evidence
and supports these v1 metric families:

- compute and database vCPU-hours;
- compute memory GB-hours;
- Lambda GB-seconds;
- storage GB-hours and request counts;
- data transfer GB.

Every row retains the CUR2 line-item ID, usage account, service, Region,
optional resource ID, usage interval, usage type, source unit, exact source
quantity in micro-units, optional selected workload tag, and normalization
lineage.

An identity conversion is accepted only for an exact compatible source unit.
A vCPU-hour row sourced from generic hours, or a GB-hour row sourced from a
GB-month unit, requires an exact rational multiplier plus its metadata source
and version. The multiplication must be exactly divisible in micro-units; the
engine rejects rounding. Missing usage quantity is not inferred from cost, and
cost is never used as a carbon conversion factor.

AWS's proxy-metrics guidance recommends near-real-time or daily refresh with
hourly granularity where available. Sutra retains CUR2's 48-hour source SLA,
which is separate from the monthly carbon publication cadence.

## Explicit states

The proxy and provider channels independently report:

- `not_configured`
- `waiting_first_delivery`
- `empty`
- `partial`
- `stale`
- `current`

The combined snapshot reports `configuration_required`,
`waiting_first_delivery`, `empty`, `partial`, `stale`, or `current`. Missing
sources, bounded result sets, old generations, empty files, and nullable values
remain visible. A complete but empty delivery is not treated as a zero.

The dashboard projection returns two separately typed collections:

- proxy series retain their native units and exact integer micro-values;
- provider carbon series retain MTCO2e, model version, usage month, account,
  Region/location, service, method, and scope.

There is no join that attributes AWS provider carbon estimates to CUR2 tags,
workloads, or resources. Such an allocation would be a Sutra model rather than
provider evidence and requires a separately versioned, approved methodology.

## Remaining production gates

This source/engine slice and its focused tests are not production acceptance.
The remaining gates are:

1. create a version-pinned `CARBON_EMISSIONS` export with all 23 columns using
   the separate provisioner role;
2. add its exact S3 bucket/prefix/object permission binding to the read-only
   collector and broker attestation;
3. implement CSV/Parquet normalization that preserves source decimal strings;
4. atomically persist generations, objects, periods, rows, and source-health
   evidence under the tenant boundary;
5. add tenant-scoped route, UI, download, and audit behavior;
6. validate a first monthly delivery, a historical backfill, an empty file, a
   model correction, member-account churn, stale/partial states, and cross-
   tenant rejection in production-like E2E tests.
